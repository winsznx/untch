// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { AuthorizedWriters } from "./AuthorizedWriters.sol";

/// @title UntchReceipts
/// @author Untch
/// @notice PRD §10.3 — the versioned, events-only public receipt log. An authorized writer batches
/// payment receipts on-chain (`logReceipts`) and anchors vendor/buyer score roots (`anchorScore`)
/// and periodic audit reports (`anchorAudit`). On-chain carries **hashes and metadata only** —
/// taskHash, policyHash, intentHash, metadataHash, amounts, IDs, decisions, tier (§10.3); prompts,
/// outputs, and business payloads stay off-chain/encrypted. *Public proof. Private work. Accountable
/// payment.* This is the contract that finally produces the **measured gas/receipt** number §17 and
/// §25 have promised since before any contract existed (§10.4: "no cost claims before measurement").
///
/// @dev Custody posture (PRD §16 I4 — funds sovereignty): this contract holds NO funds, ever. There
/// is deliberately no `payable` function, no `receive`, and no `fallback`. It emits events and keeps
/// the two pieces of state §10.3 implies — a monotonic batch counter and the admin timelock's pending
/// set — and nothing else. If a future change adds a way for value to enter here, it is in the wrong
/// contract.
///
/// APPEND-ONLY LOG, NOT A GATE. Unlike SpendIntentRegistry (§10.2), which gates money-adjacent state
/// transitions and therefore derives its `intentHash` on-chain, this contract gates nothing — it
/// records what an authorized writer attests happened. That difference drives two deliberate choices
/// documented at their definitions and in contracts/README.md so they are easy to correct if a
/// reading was wrong:
///   1. `agentId` SEMANTICS: the `bytes32 agentId` in `ReceiptLogged`/`AuditAnchored` is the §8.1
///      SpendIntent's `buyerAgentId`/`workerAgentId` (a `uint256` numeric identity-registry ID) cast
///      directly to `bytes32` — NOT an address. It is a DIFFERENT concept from the `agent: address`
///      (real EVM wallet) that SpendIntentRegistry/UntchVault use. See `Receipt.agentId`.
///   2. `receiptId` is CALLER-SUPPLIED, not derived on-chain. See `Receipt.receiptId` / `logReceipts`.
///
/// ACCESS CONTROL is the shared admin-managed authorized-writer allowlist (`AuthorizedWriters`), the
/// same base SpendIntentRegistry uses — but §10.3 additionally requires the admin to sit **behind a
/// timelock**. Writer-set changes here are proposed, wait a fixed delay, then execute (`propose` /
/// `execute` / `cancel`). This is a DELIBERATE difference from SpendIntentRegistry, whose admin is
/// immediate: §10.3's spec calls for a timelock; §10.2's did not (see judgment call 3 in the README).
contract UntchReceipts is AuthorizedWriters {
    /// @notice Receipt schema version, stamped by the contract into every `ReceiptLogged` (§10.3
    /// "versioned"). Starts at 1. A schema change is a new contract version, not a mutable field —
    /// this is a `constant`, so a writer can never forge the version an off-chain indexer keys on.
    uint16 public constant SCHEMA_VERSION = 1;

    /// @notice A queued admin operation's kind (the only operations the timelock guards).
    /// @dev `NONE` is the zero-value sentinel: it is never a real queued op (it means "no operation")
    /// and `propose` rejects it. The three real kinds are exactly the `AuthorizedWriters` mutators.
    enum OpKind {
        NONE,
        ADD_WRITER,
        REMOVE_WRITER,
        TRANSFER_ADMIN
    }

    /// @notice One payment receipt to log — the §10.3 `ReceiptLogged` payload MINUS `schemaVersion`
    /// (which the contract stamps as `SCHEMA_VERSION`, so a writer cannot forge it).
    /// @dev Field order matches the §10.3 event's field order for a 1:1 mapping. Two decisions live in
    /// this struct's shape:
    ///
    ///   • `receiptId` is CALLER-SUPPLIED (judgment call 2). SpendIntentRegistry derives `intentHash`
    ///     on-chain because a hash/struct mismatch there would be a real correctness bug in a contract
    ///     gating money-adjacent transitions. UntchReceipts is an append-only historical log — it
    ///     gates nothing — so on-chain derivation would add complexity with no correctness benefit.
    ///     The writer supplies `receiptId`; the contract records it verbatim. This is a considered
    ///     scope choice, not an oversight.
    ///
    ///   • `agentId` is a `bytes32` NUMERIC IDENTITY ID (judgment call 1). It is the §8.1
    ///     `buyerAgentId`/`workerAgentId` (`uint256`) cast directly to `bytes32` — `bytes32(uint256)`,
    ///     right-aligned — NOT an address packed into `bytes32`. This is semantically distinct from
    ///     the `agent: address` field elsewhere (SpendIntentRegistry/UntchVault), which is the real
    ///     EVM wallet executing or holding funds. Two legitimately different concepts that share the
    ///     word "agent": an identity-registry-style number here vs. a wallet address there. An indexer
    ///     MUST NOT `address(uint160(agentId))` this value — that would silently truncate a numeric ID
    ///     into a bogus address.
    ///
    /// Field order matches the §10.3 event 1:1 and is NOT reordered for storage packing: this struct
    /// is calldata-only (never stored), where every field occupies a full word regardless of type, so
    /// packing yields nothing — while reordering would break the event-mapping clarity. The
    /// `gas-struct-packing` lint is dispositioned here for that reason.
    // solhint-disable-next-line gas-struct-packing
    struct Receipt {
        bytes32 receiptId; // caller-supplied (judgment call 2)
        uint256 policyId; // uint256 end-to-end (§10.3 "type discipline")
        bytes32 policyHash; // the separate bytes32 ruleset hash
        bytes32 agentId; // bytes32(uint256 buyerAgentId/workerAgentId) — NOT an address (call 1)
        bytes32 vendorId;
        uint256 amount; // base units
        address token;
        bytes32 category;
        uint8 payType; // A2MCP | A2A
        bytes32 intentHash;
        bytes32 taskHash;
        uint8 decision;
        uint8 verifyResult;
        uint8 proofTier;
        bytes32 metadataHash;
    }

    /// @notice The fixed timelock delay (seconds) for admin writer-set changes. Immutable — chosen at
    /// deploy and unchangeable, so the guarantee "a change proposed at T cannot take effect before
    /// T + delay" is fixed for the life of the contract.
    uint64 public immutable timelockDelay;

    /// @notice Number of `logReceipts` batches recorded so far (the §10.3 "batch writer" counter).
    /// @dev Monotonically increasing; the id of a batch is its post-increment value (first batch = 1,
    /// so 0 unambiguously means "no batch"). This is the only receipt-side state — individual receipts
    /// live in events, never storage (events-only design).
    uint256 public batchCount;

    /// @notice Earliest-execution timestamp of each pending admin op, keyed by `opId`. 0 = not pending.
    /// @dev The timelock's entire state: an op's `eta` (proposal time + `timelockDelay`). Executing or
    /// cancelling clears it back to 0. Keyed by `opId(kind, target)` so the same op cannot be queued
    /// twice concurrently, while distinct ops (different kind or target) coexist.
    mapping(bytes32 opId => uint64 eta) public opEta;

    /// @notice A batch of receipts was logged (one `ReceiptLogged` per entry precedes this).
    /// @param batchId This batch's id (post-increment `batchCount`; ≥ 1).
    /// @param receiptCount Number of receipts in the batch.
    /// @param writer The authorized writer that logged them.
    event BatchLogged(
        uint256 indexed batchId, uint256 indexed receiptCount, address indexed writer
    );

    /// @notice A single payment receipt (§10.3 `ReceiptLogged`, verbatim field order/types).
    /// @dev `schemaVersion` is stamped by the contract (`SCHEMA_VERSION`), not caller-supplied.
    /// `policyId`/`agentId`/`vendorId` are the three indexed topics §10.3 specifies. See `Receipt` for
    /// the `agentId` (numeric ID, not address) and `receiptId` (caller-supplied) semantics.
    /// @param schemaVersion Contract-stamped receipt schema version (`SCHEMA_VERSION`).
    /// @param receiptId Caller-supplied receipt id (judgment call 2), recorded verbatim.
    /// @param policyId The policy this receipt was evaluated under (`uint256` end-to-end).
    /// @param policyHash The committed ruleset hash (separate `bytes32`).
    /// @param agentId Numeric identity id (`bytes32(uint256)`) — NOT an address (judgment call 1).
    /// @param vendorId The counterparty/vendor id.
    /// @param amount Settled amount in token base units.
    /// @param token The settlement token address.
    /// @param category Payment category code.
    /// @param payType A2MCP | A2A.
    /// @param intentHash The bounded SpendIntent hash this receipt settles.
    /// @param taskHash The task hash.
    /// @param decision The preflight decision code.
    /// @param verifyResult The delivery-verification result code.
    /// @param proofTier The proof tier achieved.
    /// @param metadataHash Hash of the (redacted) off-chain payment metadata.
    event ReceiptLogged(
        uint16 schemaVersion,
        bytes32 receiptId,
        uint256 indexed policyId,
        bytes32 policyHash,
        bytes32 indexed agentId,
        bytes32 indexed vendorId,
        uint256 amount,
        address token,
        bytes32 category,
        uint8 payType,
        bytes32 intentHash,
        bytes32 taskHash,
        uint8 decision,
        uint8 verifyResult,
        uint8 proofTier,
        bytes32 metadataHash
    );

    // ScoreAnchored and AuditAnchored are emitted with their §10.3 signatures VERBATIM — non-indexed,
    // exactly as the PRD specifies. These low-volume anchor events are decoded from data by the
    // indexer per the PRD's event contract; indexing `epoch`/`subjectKind`/`period` (what
    // gas-indexed-events would have us do) would change how that indexer subscribes and diverge from
    // the given spec. The rule is dispositioned over just these two events for that spec-fidelity
    // reason (see contracts/slither-triage.md). ReceiptLogged's own three indexed topics ARE honored.
    /* solhint-disable gas-indexed-events */

    /// @notice A vendor/buyer score merkle root was anchored (§10.3).
    /// @param merkleRoot Root of the score tree for this epoch (non-zero; enforced).
    /// @param epoch The scoring epoch this root covers.
    /// @param subjectKind What the root scores — vendor | buyer (raw per §10.3; not constrained here).
    event ScoreAnchored(bytes32 merkleRoot, uint64 epoch, uint8 subjectKind);

    /// @notice A periodic audit/reconciliation report was anchored (§10.3).
    /// @dev `agentId` here is the same numeric identity id as `Receipt.agentId`, NOT an address.
    /// @param reportHash Hash of the off-chain report artifact (non-zero; enforced).
    /// @param agentId The subject agent's numeric identity id (`bytes32(uint256)`), not an address.
    /// @param period The reporting period the report covers.
    event AuditAnchored(bytes32 reportHash, bytes32 agentId, uint64 period);

    /* solhint-enable gas-indexed-events */

    /// @notice An admin writer-set operation was proposed and is now in the timelock.
    /// @param opId Deterministic id of the op (`opId(kind, target)`).
    /// @param kind The operation kind.
    /// @param target The op's target address (new writer, writer to remove, or new admin).
    /// @param eta Earliest timestamp the op may execute (proposal time + `timelockDelay`).
    event OpProposed(bytes32 indexed opId, OpKind indexed kind, address indexed target, uint64 eta);

    /// @notice A timelocked admin operation was executed after its delay elapsed.
    /// @param opId The executed op's id.
    /// @param kind The operation kind.
    /// @param target The op's target address.
    event OpExecuted(bytes32 indexed opId, OpKind indexed kind, address indexed target);

    /// @notice A pending admin operation was cancelled before execution.
    /// @param opId The cancelled op's id.
    /// @param kind The operation kind.
    /// @param target The op's target address.
    event OpCancelled(bytes32 indexed opId, OpKind indexed kind, address indexed target);

    /// @notice An empty receipt array was supplied — a batch must log at least one receipt.
    error EmptyBatch();

    /// @notice A score root of zero was supplied; an anchor must reference a real merkle root.
    error ZeroMerkleRoot();

    /// @notice A report hash of zero was supplied; an audit anchor must reference a real report.
    error ZeroReportHash();

    /// @notice A timelock delay of zero was supplied at construction; a zero-delay timelock is none.
    error ZeroDelay();

    /// @notice `OpKind.NONE` was proposed; it is the sentinel, not a real operation.
    error InvalidOpKind();

    /// @notice An operation with this `opId` is already pending — cancel or execute it first.
    error OpAlreadyPending(bytes32 opId);

    /// @notice No pending operation exists for `opId` (never proposed, already executed, or cancelled).
    error OpNotFound(bytes32 opId);

    /// @notice The timelock delay has not elapsed, so the op cannot execute yet.
    error TimelockNotElapsed(bytes32 opId, uint64 eta, uint64 nowTs);

    /// @notice Deploy the receipt log with a fixed admin timelock delay.
    /// @dev The `AuthorizedWriters` base constructor runs first, setting the deployer as admin (not a
    /// writer). `delay` is fixed for the life of the contract; zero is rejected (a zero-delay timelock
    /// provides no timelock). The deployer authorizes writers afterward via `propose`/`execute`.
    /// @param delay The timelock delay in seconds for every admin writer-set change.
    constructor(uint64 delay) {
        if (delay == 0) revert ZeroDelay();
        timelockDelay = delay;
    }

    /// @notice Log a batch of payment receipts, emitting one `ReceiptLogged` per entry and one
    /// `BatchLogged` for the batch.
    /// @dev Writer-gated. Each receipt is recorded VERBATIM (append-only log; the contract validates
    /// nothing about a receipt's contents — that is judgment call 2's whole point). `schemaVersion` is
    /// stamped as `SCHEMA_VERSION` so a writer cannot forge it. The only guard is a non-empty batch:
    /// an empty array is a caller error (a no-op that would emit a misleading `BatchLogged(count=0)`).
    /// The batch counter increments once per call and the id is emitted so receipts in a tx correlate
    /// to their batch. Events-only: nothing about the receipts is written to storage.
    /// @param receipts The receipts to log (non-empty).
    /// @return batchId This batch's id (post-increment `batchCount`).
    function logReceipts(Receipt[] calldata receipts)
        external
        onlyWriter
        returns (uint256 batchId)
    {
        uint256 n = receipts.length;
        if (n == 0) revert EmptyBatch();

        for (uint256 i = 0; i < n; ++i) {
            Receipt calldata r = receipts[i];
            emit ReceiptLogged(
                SCHEMA_VERSION,
                r.receiptId,
                r.policyId,
                r.policyHash,
                r.agentId,
                r.vendorId,
                r.amount,
                r.token,
                r.category,
                r.payType,
                r.intentHash,
                r.taskHash,
                r.decision,
                r.verifyResult,
                r.proofTier,
                r.metadataHash
            );
        }

        batchId = ++batchCount;
        emit BatchLogged(batchId, n, msg.sender);
    }

    /// @notice Anchor a vendor/buyer score merkle root for an epoch (§10.3 `ScoreAnchored`).
    /// @dev Writer-gated. Rejects a zero root (a meaningless anchor), matching the repo's
    /// reject-meaningless-input discipline; otherwise records exactly what the writer attests.
    /// `subjectKind` is passed through raw (vendor | buyer per §10.3) — not constrained on-chain, in
    /// keeping with the append-only posture.
    /// @param merkleRoot Root of the score tree (non-zero).
    /// @param epoch The scoring epoch.
    /// @param subjectKind vendor | buyer (raw §10.3 code).
    function anchorScore(bytes32 merkleRoot, uint64 epoch, uint8 subjectKind) external onlyWriter {
        if (merkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        emit ScoreAnchored(merkleRoot, epoch, subjectKind);
    }

    /// @notice Anchor a periodic audit/reconciliation report (§10.3 `AuditAnchored`).
    /// @dev Writer-gated. Rejects a zero report hash (a meaningless anchor). `agentId` is the numeric
    /// identity id (judgment call 1), not an address.
    /// @param reportHash Hash of the off-chain report artifact (non-zero).
    /// @param agentId Subject agent's numeric identity id (`bytes32(uint256)`), not an address.
    /// @param period The reporting period.
    function anchorAudit(bytes32 reportHash, bytes32 agentId, uint64 period) external onlyWriter {
        if (reportHash == bytes32(0)) revert ZeroReportHash();
        emit AuditAnchored(reportHash, agentId, period);
    }

    /// @notice Propose an admin writer-set change into the timelock.
    /// @dev Admin-gated. Validates shape (real kind; non-zero target — no op sensibly targets the zero
    /// address) and that the same op is not already pending, then records `eta = now + timelockDelay`.
    /// The op takes effect only via `execute`, and only once `eta` is reached (judgment call 3's
    /// property). Deep state validity (already-a-writer, not-a-writer) is enforced by the base mutators
    /// at `execute` time — if it fails then, the admin can `cancel`.
    /// @param kind ADD_WRITER | REMOVE_WRITER | TRANSFER_ADMIN.
    /// @param target New writer, writer to remove, or new admin.
    /// @return id The op's deterministic id.
    function propose(OpKind kind, address target) external onlyAdmin returns (bytes32 id) {
        if (kind == OpKind.NONE) revert InvalidOpKind();
        if (target == address(0)) revert ZeroAddress();
        id = opId(kind, target);
        if (opEta[id] != 0) revert OpAlreadyPending(id);

        // block.timestamp is read into a uint64 local before use — the same intentional, dispositioned
        // time dependency as the two registries (a few seconds of validator skew is immaterial to a
        // timelock delay of minutes/days), and it satisfies the Foundry block-timestamp build lint.
        // solhint-disable-next-line not-rely-on-time
        uint64 eta = uint64(block.timestamp) + timelockDelay;
        opEta[id] = eta;
        emit OpProposed(id, kind, target, eta);
    }

    /// @notice Execute a pending admin op once its timelock delay has elapsed.
    /// @dev Admin-gated. Reverts if the op is not pending (`OpNotFound`) or the delay has not elapsed
    /// (`TimelockNotElapsed`). Clears the pending entry, then applies the change through the shared
    /// base mutator (which carries the zero/already/not-a-writer guards). The property judgment call 3
    /// requires — a change proposed at T cannot take effect before T + delay, under any caller or
    /// ordering — holds because this is the ONLY path that applies the change and it enforces
    /// `block.timestamp >= eta`.
    /// @param kind The op kind (must match what was proposed — it is part of `opId`).
    /// @param target The op target (must match what was proposed).
    function execute(OpKind kind, address target) external onlyAdmin {
        bytes32 id = opId(kind, target);
        uint64 eta = opEta[id];
        if (eta == 0) revert OpNotFound(id);

        // solhint-disable-next-line not-rely-on-time
        uint64 nowTs = uint64(block.timestamp);
        // solhint-disable-next-line gas-strict-inequalities
        if (nowTs < eta) revert TimelockNotElapsed(id, eta, nowTs);

        delete opEta[id];
        if (kind == OpKind.ADD_WRITER) _addWriter(target);
        else if (kind == OpKind.REMOVE_WRITER) _removeWriter(target);
        else _transferAdmin(target); // TRANSFER_ADMIN — the only remaining queueable kind

        emit OpExecuted(id, kind, target);
    }

    /// @notice Cancel a pending admin op before it executes.
    /// @dev Admin-gated. Reverts if no op is pending for `(kind, target)`. Clears the pending entry so
    /// the op can be re-proposed later if desired.
    /// @param kind The op kind.
    /// @param target The op target.
    function cancel(OpKind kind, address target) external onlyAdmin {
        bytes32 id = opId(kind, target);
        if (opEta[id] == 0) revert OpNotFound(id);
        delete opEta[id];
        emit OpCancelled(id, kind, target);
    }

    /// @notice Deterministic id of an admin op — `keccak256(abi.encode(kind, target))`.
    /// @dev Public+pure so callers (and the demo/indexer) can compute the id the timelock keys on
    /// without a state read; `propose`/`execute`/`cancel` call it internally. `abi.encode` (not
    /// packed) keeps the enum and address in separate 32-byte words, so no encoding collision is
    /// possible across kinds/targets.
    /// @param kind The op kind.
    /// @param target The op target.
    /// @return The op id.
    function opId(OpKind kind, address target) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, target));
    }
}
