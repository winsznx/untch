// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { IntentHash } from "./lib/IntentHash.sol";
import { AuthorizedWriters } from "./AuthorizedWriters.sol";

/// @title SpendIntentRegistry
/// @author Untch
/// @notice PRD §10.2 — the on-chain lifecycle anchor for a bounded SpendIntent (§8.1). It maps the
/// canonical `intentHash` to `{policyId, maxAmount, deadline, status}` so the vault (§7.5) and any
/// auditor can prove, from chain state alone, that a specific bounded intent existed and what
/// lifecycle state it reached. Larger intents are anchored here (policy `anchorIntentsAbove`, §10.2);
/// micro A2MCP intents stay off-chain with the intentHash carried in the receipt.
/// @dev Custody posture (PRD §16 I4 — funds sovereignty): this contract holds NO funds, ever. There
/// is deliberately no `payable` function, no `receive`, and no `fallback`, so it cannot accept native
/// value and has no deposit/withdraw surface. It stores hashes and metadata only. If a future change
/// adds a way for value to enter here, that change is in the wrong contract.
///
/// The `intentHash` is ALWAYS derived on-chain from the struct via the shared `IntentHash` library
/// (the D0.5 canonicalization differential proves that library agrees byte-for-byte with the
/// the off-chain canon package). No function accepts a caller-supplied hash as an independent argument,
/// so a caller can never register a record under a hash that doesn't describe the struct it claims.
///
/// Three spec-interpretation / modelling decisions are documented at their definitions and in
/// contracts/README.md so they are easy to correct if a reading was wrong:
///   1. ACCESS CONTROL = an admin-managed AUTHORIZED WRITER SET, deliberately NOT owner-gated like
///      PolicyRegistry (see `registerIntent`). This is the coherent design for an object created
///      constantly by software on an owner's behalf; it mirrors the §10.3 UntchReceipts writer-set
///      pattern, not §10.1's per-owner gating. The allowlist itself (admin/writer roles, add/remove/
///      transfer) lives in the shared `AuthorizedWriters` base; §10.2 surfaces it as IMMEDIATE
///      `onlyAdmin` externals (its admin is deliberately un-timelocked for this first pass — §10.3's
///      UntchReceipts is the contract that adds the timelock the base is designed to support).
///   2. NO cross-contract validation of `policyId` against PolicyRegistry in this first pass — the
///      id is stored as an opaque reference (see `registerIntent`). Off-chain preflight has already
///      evaluated the intent against the real policy; on-chain re-verification would be
///      defense-in-depth, named as a future hardening in the README, not folded in silently now.
///   3. STATUS = {NONE, PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED} with expiry DERIVED, never a
///      stored EXPIRED state (see `Status` / `isExpired` / `isUsable`), and `setStatus` accepts any
///      real lifecycle state from a writer — the transition DAG is enforced off-chain (also a named
///      future hardening). Same precedent as PolicyRegistry's derived-expiry `isUsable`.
contract SpendIntentRegistry is AuthorizedWriters {
    /// @notice Lifecycle state of an anchored intent (PRD §10.2, minus the stored `EXPIRED` member).
    /// @dev The five real lifecycle states are {PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED}, exactly
    /// as §10.2 lists them minus `EXPIRED`. `NONE` is the zero-value EXISTENCE sentinel — an
    /// unregistered `intentHash` reads back as `NONE`, which is what lets mutators/readers reject a
    /// nonexistent intent — NOT a lifecycle state an intent transitions into. This mirrors
    /// PolicyRegistry's {NONE, ACTIVE, PAUSED} exactly: same sentinel idiom, more lifecycle members.
    /// `EXPIRED` is intentionally absent: expiry is derived at read time (`isExpired`,
    /// `block.timestamp > deadline`), never stored, so nobody has to fire a transition tx at the exact
    /// instant a deadline passes.
    enum Status {
        NONE,
        PENDING,
        APPROVED,
        BLOCKED,
        SETTLED,
        DISPUTED
    }

    /// @notice A registered intent record — the §10.2 shape `{policyId, maxAmount, deadline, status}`.
    /// @dev `owner` from the §8.1 struct is deliberately NOT stored (it is emitted in
    /// `IntentRegistered` for log indexing instead) — §10.2 stores only these four fields, keeping the
    /// record to three slots. Field ORDER is chosen for storage packing: `policyId` (32) fills slot 0,
    /// `maxAmount` (32) fills slot 1, and `deadline` (8) + `status` (1) share slot 2. `deadline` is
    /// narrowed to `uint64` (the §8.1 struct field is `uint256`); `registerIntent` rejects any
    /// `deadline` that would not fit, so the stored value always equals the hashed value.
    struct IntentRecord {
        uint256 policyId;
        uint256 maxAmount;
        uint64 deadline;
        Status status;
    }

    /// @notice Full intent record by hash. Private so reads go through `getIntent`, which reverts on a
    /// nonexistent hash instead of returning a zeroed struct that looks deceptively valid.
    mapping(bytes32 intentHash => IntentRecord record) private _intents;

    /// @notice A new intent was anchored (status PENDING).
    /// @param intentHash Canonical hash derived on-chain from the §8.1 struct via `IntentHash`.
    /// @param policyId The policy this intent was evaluated under (opaque reference; not validated
    /// against PolicyRegistry here — see decision #2).
    /// @param owner The §8.1 operator wallet the intent belongs to (emitted for indexing, not stored).
    /// @param maxAmount The intent's spend bound, in token base units.
    /// @param deadline Unix second after which the intent is expired (derived, never a stored state).
    event IntentRegistered(
        bytes32 indexed intentHash,
        uint256 indexed policyId,
        address indexed owner,
        uint256 maxAmount,
        uint64 deadline
    );

    /// @notice An anchored intent's lifecycle status changed.
    /// @param intentHash The intent whose status changed.
    /// @param newStatus The status just written (indexed so "all intents that reached BLOCKED / SETTLED
    /// / …" is searchable in logs).
    /// @param writer The authorized writer that made the change.
    /// @param previousStatus The status this write replaced.
    event IntentStatusChanged(
        bytes32 indexed intentHash,
        Status indexed newStatus,
        address indexed writer,
        Status previousStatus
    );

    /// @notice No intent exists for `intentHash`.
    error IntentNotFound(bytes32 intentHash);

    /// @notice An intent is already registered under `intentHash` — refuse rather than clobber it.
    error IntentAlreadyRegistered(bytes32 intentHash);

    /// @notice `policyId` of zero was supplied; an anchored intent must reference a real policy.
    error ZeroPolicyId();

    /// @notice `deadline` is not strictly in the future, so the intent would be born expired.
    error DeadlineInPast(uint64 deadline, uint64 nowTs);

    /// @notice `deadline` exceeds `uint64`, so it cannot be stored without truncating the hashed value.
    error DeadlineTooFar(uint256 deadline);

    /// @notice `NONE` was supplied as a target status; it is the existence sentinel, not a state an
    /// intent can be set to (that would corrupt the record's existence marker).
    error StatusCannotBeNone();

    /// @notice Anchor a bounded SpendIntent, deriving its canonical hash on-chain from the struct.
    /// @dev Writer-gated (decision #1). The `intentHash` is computed with `IntentHash.hashIntent` — a
    /// caller can never supply a hash independently of the struct, so a hash/struct mismatch is
    /// unreachable through this interface. `policyId` is stored as an opaque reference and is NOT
    /// checked against PolicyRegistry (decision #2). `maxAmount` and `deadline` are copied from the
    /// struct (`deadline` narrowed to `uint64`, with an explicit fit check so no truncation can make
    /// the stored deadline disagree with the hashed one). Initial status is always PENDING (§7.1:
    /// "register on-chain: PENDING", before the preflight decision moves it via `setStatus`).
    /// @param intent The bounded SpendIntent (§8.1), hashed verbatim in declared field order.
    /// @param policyId The policy the off-chain engine evaluated this intent under (non-zero).
    /// @return intentHash The canonical hash the record is keyed by.
    function registerIntent(IntentHash.SpendIntent calldata intent, uint256 policyId)
        external
        onlyWriter
        returns (bytes32 intentHash)
    {
        if (policyId == 0) revert ZeroPolicyId();
        if (intent.deadline > type(uint64).max) revert DeadlineTooFar(intent.deadline);
        uint64 deadline = uint64(intent.deadline);
        // solhint-disable-next-line not-rely-on-time
        uint64 nowTs = uint64(block.timestamp);
        // Inclusive by design (matches PolicyRegistry): a deadline equal to the current second is
        // treated as already past at registration.
        // solhint-disable-next-line gas-strict-inequalities
        if (deadline <= nowTs) revert DeadlineInPast(deadline, nowTs);

        intentHash = IntentHash.hashIntent(intent);
        if (_intents[intentHash].status != Status.NONE) revert IntentAlreadyRegistered(intentHash);

        _intents[intentHash] = IntentRecord({
            policyId: policyId,
            maxAmount: intent.maxAmount,
            deadline: deadline,
            status: Status.PENDING
        });

        emit IntentRegistered(intentHash, policyId, intent.owner, intent.maxAmount, deadline);
    }

    /// @notice Transition an anchored intent to a new lifecycle status.
    /// @dev Writer-gated (decision #1). Reverts if the intent does not exist and if `newStatus` is
    /// `NONE` (which would corrupt the existence sentinel). It does NOT enforce a transition DAG in
    /// this first pass (decision #3): the off-chain policy engine drives the lifecycle and has already
    /// validated each transition; an on-chain DAG here would be defense-in-depth (named future
    /// hardening), and constraining a guessed graph risks rejecting a legitimate transition. The core
    /// record data (`policyId`, `maxAmount`, `deadline`) is never touched here — only `status` moves.
    /// @param intentHash The intent to transition.
    /// @param newStatus The lifecycle status to set (any of PENDING/APPROVED/BLOCKED/SETTLED/DISPUTED).
    function setStatus(bytes32 intentHash, Status newStatus) external onlyWriter {
        if (newStatus == Status.NONE) revert StatusCannotBeNone();
        IntentRecord storage rec = _intents[intentHash];
        Status previousStatus = rec.status;
        if (previousStatus == Status.NONE) revert IntentNotFound(intentHash);

        rec.status = newStatus;
        emit IntentStatusChanged(intentHash, newStatus, msg.sender, previousStatus);
    }

    /// @notice Grant writer authorization to `writer`.
    /// @dev Admin-gated and IMMEDIATE — §10.2's admin is deliberately un-timelocked for this first
    /// pass (its deployed, testnet-verified behavior). The guard + event live in the shared
    /// `AuthorizedWriters` base (`_addWriter`): reverts on the zero address and on an
    /// already-authorized writer (no silent no-op). §10.3's UntchReceipts routes the same base call
    /// through a timelock instead; that difference is per-contract by design.
    /// @param writer The address to authorize.
    function addWriter(address writer) external onlyAdmin {
        _addWriter(writer);
    }

    /// @notice Revoke writer authorization from `writer`.
    /// @dev Admin-gated and immediate; guard + event in the `AuthorizedWriters` base
    /// (`_removeWriter`): reverts if the address is not currently a writer (no silent no-op).
    /// @param writer The address to de-authorize.
    function removeWriter(address writer) external onlyAdmin {
        _removeWriter(writer);
    }

    /// @notice Transfer the admin role to `newAdmin`.
    /// @dev Admin-gated and immediate; guard + event in the `AuthorizedWriters` base
    /// (`_transferAdmin`): reverts on the zero address (which would brick writer-set management).
    /// Admin and writer are separate roles: transferring admin does not change the writer set.
    /// @param newAdmin The address to become admin.
    function transferAdmin(address newAdmin) external onlyAdmin {
        _transferAdmin(newAdmin);
    }

    /// @notice Read an intent record, reverting if it does not exist.
    /// @param intentHash The intent to read.
    /// @return The full intent record.
    function getIntent(bytes32 intentHash) external view returns (IntentRecord memory) {
        IntentRecord memory rec = _intents[intentHash];
        if (rec.status == Status.NONE) revert IntentNotFound(intentHash);
        return rec;
    }

    /// @notice Whether an intent has been anchored under `intentHash`.
    /// @param intentHash The candidate hash.
    /// @return True once `registerIntent` has created it.
    function exists(bytes32 intentHash) external view returns (bool) {
        return _intents[intentHash].status != Status.NONE;
    }

    /// @notice Whether an intent is past its deadline right now (the derived-expiry rule).
    /// @dev `block.timestamp > deadline`, computed at read time — expiry is never a stored, separately
    /// transitioned state (decision #3). A nonexistent intent (`deadline == 0`) reads as expired, which
    /// is the safe default; callers gating a spend should use `isUsable`, which also requires existence
    /// via the APPROVED status. Read into a local first so both the block-timestamp build lint and
    /// Slither's timestamp detector see the same intentional, dispositioned pattern as PolicyRegistry.
    /// @param intentHash The intent to check.
    /// @return True iff the current time is strictly past the intent's deadline.
    function isExpired(bytes32 intentHash) external view returns (bool) {
        // solhint-disable-next-line not-rely-on-time
        uint64 nowTs = uint64(block.timestamp);
        // solhint-disable-next-line gas-strict-inequalities
        return nowTs > _intents[intentHash].deadline;
    }

    /// @notice Whether an intent may authorize a spend right now — the canonical enforcement check.
    /// @dev The derived rule the vault (§7.5) turns on: `status == APPROVED && block.timestamp <=
    /// deadline`. Expiry is computed here, never stored, so an expired intent needs no transition tx to
    /// become unusable; a nonexistent intent (`NONE`) is not usable. This is the intent analogue of
    /// PolicyRegistry's `isUsable`: callers deciding "may this intent authorize a spend" should use
    /// THIS, not read `status` alone.
    /// @param intentHash The intent to check.
    /// @return True iff the intent is APPROVED and not past its deadline.
    function isUsable(bytes32 intentHash) external view returns (bool) {
        IntentRecord storage rec = _intents[intentHash];
        // solhint-disable-next-line not-rely-on-time
        uint64 nowTs = uint64(block.timestamp);
        // solhint-disable-next-line gas-strict-inequalities
        return rec.status == Status.APPROVED && nowTs <= rec.deadline;
    }

    /// @notice Deterministically derive the `intentHash` a given SpendIntent produces.
    /// @dev Pure mirror of the derivation `registerIntent` uses, so off-chain code can predict the id
    /// without a state read (and tests can assert the registry preserves the library hash). Identical
    /// to `IntentHash.hashIntent`, which the D0.5 differential proves equals the off-chain canon package.
    /// @param intent The bounded SpendIntent.
    /// @return The canonical intent hash.
    function previewIntentHash(IntentHash.SpendIntent calldata intent)
        external
        pure
        returns (bytes32)
    {
        return IntentHash.hashIntent(intent);
    }
}
