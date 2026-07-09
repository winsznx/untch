// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title PolicyRegistry
/// @author Untch
/// @notice PRD §10.1 — the immutable on-chain anchor proving that a committed ruleset
/// (`policyHash`) governed a given `agent` at a given time. Owners register policies, revise
/// them (`updatePolicy`, version-bumped), and pause/resume them; every mutation is gated to the
/// policy's own registered owner and emits an event so the full lifecycle is reconstructable
/// from logs alone.
/// @dev Custody posture (PRD §16 I4 — funds sovereignty): this contract holds NO funds, ever.
/// There is deliberately no `payable` function, no `receive`, and no `fallback`, so it cannot
/// accept native value and has no deposit/withdraw surface. It stores hashes and metadata only.
/// If a future change adds a way for value to enter here, that change is in the wrong contract.
///
/// Two spec-interpretation decisions are documented at their definitions and in
/// contracts/README.md so they are easy to correct if either reading was wrong:
///   1. `policyId` derivation from the owner nonce (see `registerPolicy` / `previewPolicyId`).
///   2. Status modelled as {NONE, ACTIVE, PAUSED} with expiry DERIVED, never a stored EXPIRED
///      state (see `PolicyStatus` / `isUsable`).
contract PolicyRegistry {
    /// @notice Lifecycle state of a policy.
    /// @dev `NONE` is the zero-value existence sentinel: an unregistered `policyId` reads back as
    /// `NONE`, which is what lets every mutator reject a nonexistent id. It is NOT a lifecycle
    /// state a policy transitions into. There is intentionally no `EXPIRED` member — expiry is
    /// derived at read time (`isUsable`), never stored, so no one has to fire a transition tx at
    /// the exact instant expiry passes.
    enum PolicyStatus {
        NONE,
        ACTIVE,
        PAUSED
    }

    /// @notice A registered policy record (PRD §10.1 shape: {owner, agent, policyHash, status,
    /// expiry, version}).
    /// @dev Field ORDER here is chosen for storage packing, not to match the §10.1 listing order:
    /// `owner` (20) + `expiry` (8) + `version` (4) fill slot 0 exactly; `agent` (20) + `status`
    /// (1) share slot 1; `policyHash` (32) is slot 2 — three slots total, so `registerPolicy`
    /// pays three cold SSTOREs. Consumers read by field name, so the packing order is invisible
    /// to them.
    struct Policy {
        address owner;
        uint64 expiry;
        uint32 version;
        address agent;
        PolicyStatus status;
        bytes32 policyHash;
    }

    /// @notice Full policy record by id. Private so reads go through `getPolicy`, which reverts
    /// on a nonexistent id instead of returning a zeroed struct that looks deceptively valid.
    mapping(uint256 policyId => Policy policy) private _policies;

    /// @notice Per-owner registration counter that seeds the next `policyId` for that owner.
    /// @dev Monotonic per owner; increments once per successful `registerPolicy`. This is the
    /// "owner nonce" of §10.1 — see `registerPolicy` for how it derives `policyId`.
    mapping(address owner => uint256 nonce) public ownerNonce;

    /// @notice A new policy was registered.
    /// @param policyId Derived id (see `registerPolicy`).
    /// @param owner Registrant; the only account that can later mutate this policy.
    /// @param agent Agent the policy governs.
    /// @param policyHash Canonical hash of the committed ruleset (§9 canonical JSON, off-chain).
    /// @param expiry Unix second after which the policy is no longer usable (derived).
    /// @param version Always 1 at registration; bumped by `updatePolicy`.
    event PolicyRegistered(
        uint256 indexed policyId,
        address indexed owner,
        address indexed agent,
        bytes32 policyHash,
        uint64 expiry,
        uint32 version
    );

    /// @notice A policy's ruleset hash and/or expiry were revised.
    /// @param policyId The policy revised.
    /// @param owner The policy owner (unchanged by an update).
    /// @param newPolicyHash Replacement canonical ruleset hash (indexed so an anchored ruleset is
    /// searchable in logs).
    /// @param previousPolicyHash The ruleset hash this update replaced.
    /// @param newExpiry Replacement expiry (unix seconds).
    /// @param version The post-update version (previous + 1).
    event PolicyUpdated(
        uint256 indexed policyId,
        address indexed owner,
        bytes32 indexed newPolicyHash,
        bytes32 previousPolicyHash,
        uint64 newExpiry,
        uint32 version
    );

    /// @notice A policy was paused (ACTIVE → PAUSED).
    /// @param policyId The policy paused.
    /// @param owner The policy owner.
    event PolicyPaused(uint256 indexed policyId, address indexed owner);

    /// @notice A policy was resumed (PAUSED → ACTIVE).
    /// @param policyId The policy resumed.
    /// @param owner The policy owner.
    event PolicyResumed(uint256 indexed policyId, address indexed owner);

    /// @notice No policy exists for `policyId`.
    error PolicyNotFound(uint256 policyId);

    /// @notice `caller` is not the registered owner of `policyId`.
    error NotPolicyOwner(uint256 policyId, address caller);

    /// @notice The derived `policyId` is already in use — refuse rather than clobber a record.
    error PolicyIdCollision(uint256 policyId);

    /// @notice A ruleset hash of zero was supplied; a policy must anchor a real committed ruleset.
    error ZeroPolicyHash();

    /// @notice The zero address was supplied as the governed agent.
    error ZeroAgent();

    /// @notice `expiry` is not strictly in the future, so the policy would be born unusable.
    error ExpiryInPast(uint64 expiry, uint64 nowTs);

    /// @notice The policy is not ACTIVE, so it cannot be paused.
    error PolicyNotActive(uint256 policyId);

    /// @notice The policy is not PAUSED, so it cannot be resumed.
    error PolicyNotPaused(uint256 policyId);

    /// @notice Restrict a mutation to the policy's registered owner, rejecting nonexistent ids.
    /// @dev Existence is checked before ownership so a call against an unregistered id reverts
    /// with `PolicyNotFound` rather than a misleading `NotPolicyOwner`.
    /// @param policyId The policy being mutated.
    modifier onlyPolicyOwner(uint256 policyId) {
        Policy storage p = _policies[policyId];
        if (p.status == PolicyStatus.NONE) revert PolicyNotFound(policyId);
        if (msg.sender != p.owner) revert NotPolicyOwner(policyId, msg.sender);
        _;
    }

    /// @notice Register a new policy owned by the caller and governing `agent`.
    /// @dev policyId derivation (INTERPRETATION of the terse §10.1 "owner nonce" line, not
    /// verbatim spec — correctable): `policyId = uint256(keccak256(abi.encodePacked(owner,
    /// nonce)))` where `nonce = ownerNonce[owner]` at call time, then incremented. This is chosen
    /// over a single global auto-increment so any owner can register policies without contending
    /// on one shared counter, and so ids are collision-resistant across owners. §10.1 needs no
    /// signature verification (no relayer / EIP-712 here — direct `msg.sender == owner` gating is
    /// sufficient for this first contract), so the nonce's only role is deterministic id
    /// derivation. `abi.encodePacked(address, uint256)` is unambiguous — both operands are
    /// fixed-width, so no packed-encoding collision is possible.
    /// @param agent Agent this policy governs (non-zero).
    /// @param policyHash Canonical hash of the committed ruleset (non-zero; computed off-chain
    /// with the canon package, never an ad-hoc scheme).
    /// @param expiry Unix second after which the policy stops being usable (must be in the future).
    /// @return policyId The derived id of the new policy.
    function registerPolicy(address agent, bytes32 policyHash, uint64 expiry)
        external
        returns (uint256 policyId)
    {
        if (agent == address(0)) revert ZeroAgent();
        if (policyHash == bytes32(0)) revert ZeroPolicyHash();
        // solhint-disable-next-line not-rely-on-time
        uint64 nowTs = uint64(block.timestamp);
        // Inclusive by design: a policy whose expiry equals the current second is born expired.
        // solhint-disable-next-line gas-strict-inequalities
        if (expiry <= nowTs) revert ExpiryInPast(expiry, nowTs);

        uint256 nonce = ownerNonce[msg.sender];
        policyId = previewPolicyId(msg.sender, nonce);
        // Defensive: keccak over a strictly-increasing nonce makes a repeat astronomically
        // unlikely, but never silently overwrite an existing record.
        if (_policies[policyId].status != PolicyStatus.NONE) revert PolicyIdCollision(policyId);

        ownerNonce[msg.sender] = nonce + 1;
        _policies[policyId] = Policy({
            owner: msg.sender,
            expiry: expiry,
            version: 1,
            agent: agent,
            status: PolicyStatus.ACTIVE,
            policyHash: policyHash
        });

        emit PolicyRegistered(policyId, msg.sender, agent, policyHash, expiry, 1);
    }

    /// @notice Revise a policy's ruleset hash and expiry, bumping its version.
    /// @dev Owner-gated. Status is preserved (updating a PAUSED policy leaves it PAUSED — an
    /// update revises the anchored ruleset, it does not resume). `agent` and `owner` are
    /// immutable after registration and are not touched here.
    /// @param policyId The policy to revise.
    /// @param newPolicyHash Replacement canonical ruleset hash (non-zero).
    /// @param newExpiry Replacement expiry (must be in the future).
    function updatePolicy(uint256 policyId, bytes32 newPolicyHash, uint64 newExpiry)
        external
        onlyPolicyOwner(policyId)
    {
        if (newPolicyHash == bytes32(0)) revert ZeroPolicyHash();
        // solhint-disable-next-line not-rely-on-time
        uint64 nowTs = uint64(block.timestamp);
        // Inclusive by design: expiry at the current second is already expired (see registerPolicy).
        // solhint-disable-next-line gas-strict-inequalities
        if (newExpiry <= nowTs) revert ExpiryInPast(newExpiry, nowTs);

        Policy storage p = _policies[policyId];
        bytes32 previousPolicyHash = p.policyHash;
        uint32 newVersion = p.version + 1;

        p.policyHash = newPolicyHash;
        p.expiry = newExpiry;
        p.version = newVersion;

        emit PolicyUpdated(
            policyId, msg.sender, newPolicyHash, previousPolicyHash, newExpiry, newVersion
        );
    }

    /// @notice Pause an active policy (ACTIVE → PAUSED).
    /// @dev Owner-gated. Reverts if the policy is not currently ACTIVE (so double-pause reverts).
    /// @param policyId The policy to pause.
    function pausePolicy(uint256 policyId) external onlyPolicyOwner(policyId) {
        Policy storage p = _policies[policyId];
        if (p.status != PolicyStatus.ACTIVE) revert PolicyNotActive(policyId);
        p.status = PolicyStatus.PAUSED;
        emit PolicyPaused(policyId, msg.sender);
    }

    /// @notice Resume a paused policy (PAUSED → ACTIVE).
    /// @dev Owner-gated. Reverts if the policy is not currently PAUSED (so resume-when-not-paused
    /// reverts). Expiry is intentionally not consulted: resume flips the stored status; whether
    /// the policy is usable afterwards is derived separately by `isUsable`.
    /// @param policyId The policy to resume.
    function resumePolicy(uint256 policyId) external onlyPolicyOwner(policyId) {
        Policy storage p = _policies[policyId];
        if (p.status != PolicyStatus.PAUSED) revert PolicyNotPaused(policyId);
        p.status = PolicyStatus.ACTIVE;
        emit PolicyResumed(policyId, msg.sender);
    }

    /// @notice Read a policy record, reverting if it does not exist.
    /// @param policyId The policy to read.
    /// @return The full policy record.
    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        Policy memory p = _policies[policyId];
        if (p.status == PolicyStatus.NONE) revert PolicyNotFound(policyId);
        return p;
    }

    /// @notice Whether a policy has been registered under `policyId`.
    /// @param policyId The candidate id.
    /// @return True once `registerPolicy` has created it.
    function exists(uint256 policyId) external view returns (bool) {
        return _policies[policyId].status != PolicyStatus.NONE;
    }

    /// @notice Whether a policy is usable right now — the canonical enforcement check.
    /// @dev The derived usability rule the whole design turns on: `status == ACTIVE &&
    /// block.timestamp <= expiry`. Expired-ness is computed here, never stored, so an expired
    /// policy needs no transition tx to become unusable. A nonexistent policy (`NONE`) is not
    /// usable. Callers deciding "may this ruleset authorize a spend" should use THIS, not read
    /// `status` alone.
    /// @param policyId The policy to check.
    /// @return True iff the policy is ACTIVE and not past its expiry.
    function isUsable(uint256 policyId) external view returns (bool) {
        Policy storage p = _policies[policyId];
        // Usability is time-derived and inclusive of the expiry second, verbatim per PRD §10.1
        // ("status == ACTIVE && block.timestamp <= expiry").
        // solhint-disable-next-line not-rely-on-time,gas-strict-inequalities
        return p.status == PolicyStatus.ACTIVE && block.timestamp <= p.expiry;
    }

    /// @notice Deterministically derive the `policyId` a given `owner`/`nonce` pair produces.
    /// @dev Pure mirror of the derivation in `registerPolicy`; lets off-chain code predict ids
    /// without a state read. See `nextPolicyId` for the "what id will my next registration get"
    /// convenience.
    /// @param owner The registrant address.
    /// @param nonce The owner nonce to derive against.
    /// @return The derived policy id.
    function previewPolicyId(address owner, uint256 nonce) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(owner, nonce)));
    }

    /// @notice The `policyId` that `owner`'s next `registerPolicy` call will produce.
    /// @param owner The registrant address.
    /// @return The id the next registration by `owner` will receive.
    function nextPolicyId(address owner) external view returns (uint256) {
        return previewPolicyId(owner, ownerNonce[owner]);
    }
}
