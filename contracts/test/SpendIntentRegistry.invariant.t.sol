// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { SpendIntentRegistry } from "../src/SpendIntentRegistry.sol";
import { IntentHash } from "../src/lib/IntentHash.sol";

/// @title SpendIntentRegistryHandler
/// @notice Stateful-fuzz handler (PRD §28 tier 3). Drives a bounded set of actors through random
/// sequences of writer-set management, intent registration, and status transitions — and, critically,
/// a stream of adversarial non-writer register/setStatus attempts. It mirrors the on-chain writer set
/// in ghost state, records each intent's immutable core data at registration, and counts any non-writer
/// mutation that unexpectedly succeeds; that counter must remain zero forever.
contract SpendIntentRegistryHandler is Test {
    SpendIntentRegistry internal immutable REG;

    address[] internal actors;
    bytes32[] internal hashes;
    mapping(bytes32 intentHash => bool seen) internal known;

    // Ghost mirror of the core (immutable-after-registration) record fields.
    mapping(bytes32 intentHash => uint256 policyId) public ghostPolicyId;
    mapping(bytes32 intentHash => uint256 maxAmount) public ghostMaxAmount;
    mapping(bytes32 intentHash => uint64 deadline) public ghostDeadline;

    // Ghost mirror of the writer set (the handler is the admin, so this stays in lockstep).
    mapping(address actor => bool isWriter) public ghostWriter;

    /// @notice Number of non-writer mutations that succeeded. Invariant: stays 0.
    uint256 public nonWriterSuccesses;
    /// @notice Number of adversarial non-writer attempts made (proves the attack path ran).
    uint256 public nonWriterAttempts;

    /// @dev The handler DEPLOYS the registry so it becomes the admin — that is what lets it manage the
    /// writer set directly (`addWriter` / `removeWriter`) without a prank, keeping the ghost in lockstep.
    constructor(address[] memory _actors) {
        REG = new SpendIntentRegistry();
        actors = _actors;
    }

    function registry() external view returns (SpendIntentRegistry) {
        return REG;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function count() external view returns (uint256) {
        return hashes.length;
    }

    function hashAt(uint256 i) external view returns (bytes32) {
        return hashes[i];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _pick(uint256 seed) internal view returns (bytes32 h, bool ok) {
        if (hashes.length == 0) return (bytes32(0), false);
        return (hashes[seed % hashes.length], true);
    }

    function _mkIntent(address owner, uint256 nonce, uint256 maxAmount, uint64 deadline)
        internal
        pure
        returns (IntentHash.SpendIntent memory)
    {
        return IntentHash.SpendIntent({
            owner: owner,
            buyerAgentId: uint256(uint160(owner)),
            workerAgentId: nonce,
            token: address(0x7),
            maxAmount: maxAmount,
            taskHash: keccak256(abi.encode(owner, nonce)),
            acceptanceHash: bytes32(0),
            schemaHash: keccak256("schema"),
            policyHash: keccak256("policy"),
            deadline: deadline,
            nonce: nonce
        });
    }

    function authorizeWriter(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (ghostWriter[actor]) return;
        REG.addWriter(actor); // handler == admin
        ghostWriter[actor] = true;
    }

    function deauthorizeWriter(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (!ghostWriter[actor]) return;
        REG.removeWriter(actor);
        ghostWriter[actor] = false;
    }

    function register(
        uint256 actorSeed,
        uint256 nonce,
        uint256 policyId,
        uint256 maxAmount,
        uint64 deadline
    ) external {
        address actor = _actor(actorSeed);
        if (!ghostWriter[actor]) return; // happy path: only writers register
        if (policyId == 0) policyId = 1;
        deadline = uint64(bound(uint256(deadline), block.timestamp + 1, type(uint64).max));

        IntentHash.SpendIntent memory intent = _mkIntent(actor, nonce, maxAmount, deadline);
        vm.prank(actor);
        bytes32 h = REG.registerIntent(intent, policyId);

        if (!known[h]) {
            known[h] = true;
            ghostPolicyId[h] = policyId;
            ghostMaxAmount[h] = maxAmount;
            ghostDeadline[h] = deadline;
            hashes.push(h);
        }
    }

    function setStatus(uint256 pSeed, uint256 actorSeed, uint8 statusSeed) external {
        (bytes32 h, bool ok) = _pick(pSeed);
        if (!ok) return;
        address actor = _actor(actorSeed);
        if (!ghostWriter[actor]) return;
        // 1..5 ⇒ {PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED}; never 0 (NONE).
        SpendIntentRegistry.Status s = SpendIntentRegistry.Status(uint8(bound(statusSeed, 1, 5)));
        vm.prank(actor);
        REG.setStatus(h, s);
    }

    /// @notice Adversary: a non-writer tries to register. Every attempt MUST revert.
    function attackRegister(uint256 actorSeed, uint256 nonce, uint256 policyId, uint64 deadline)
        external
    {
        address actor = _actor(actorSeed);
        if (ghostWriter[actor]) return; // only probe non-writers
        if (policyId == 0) policyId = 1;
        deadline = uint64(bound(uint256(deadline), block.timestamp + 1, type(uint64).max));
        nonWriterAttempts++;

        IntentHash.SpendIntent memory intent = _mkIntent(actor, nonce, 1, deadline);
        vm.prank(actor);
        try REG.registerIntent(intent, policyId) {
            nonWriterSuccesses++;
        } catch { }
    }

    /// @notice Adversary: a non-writer tries to setStatus. Every attempt MUST revert.
    function attackSetStatus(uint256 pSeed, uint256 actorSeed, uint8 statusSeed) external {
        (bytes32 h, bool ok) = _pick(pSeed);
        if (!ok) return;
        address actor = _actor(actorSeed);
        if (ghostWriter[actor]) return;
        SpendIntentRegistry.Status s = SpendIntentRegistry.Status(uint8(bound(statusSeed, 1, 5)));
        nonWriterAttempts++;

        vm.prank(actor);
        try REG.setStatus(h, s) {
            nonWriterSuccesses++;
        } catch { }
    }
}

/// @title SpendIntentRegistryInvariant
/// @notice PRD §28 tier-3 invariants encoding the §10.2 guarantees:
///   • ONLY authorized-writer calls ever mutate (no non-writer register/setStatus succeeds);
///   • a registered intent's underlying core data (policyId, maxAmount, deadline) NEVER changes after
///     registration — only `status` transitions;
///   • every registered intent stays in a real lifecycle state (never NONE), so the existence sentinel
///     is never corrupted.
contract SpendIntentRegistryInvariant is Test {
    SpendIntentRegistry internal reg;
    SpendIntentRegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);

        address[] memory actors = new address[](4);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");

        // The handler deploys the registry in its constructor, so the handler is the admin and can
        // manage the writer set directly.
        handler = new SpendIntentRegistryHandler(actors);
        reg = handler.registry();

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.authorizeWriter.selector;
        selectors[1] = handler.deauthorizeWriter.selector;
        selectors[2] = handler.register.selector;
        selectors[3] = handler.setStatus.selector;
        selectors[4] = handler.attackRegister.selector;
        selectors[5] = handler.attackSetStatus.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice No non-writer mutation ever succeeds.
    function invariant_OnlyWritersMutate() public view {
        assertEq(handler.nonWriterSuccesses(), 0, "a non-writer mutated an intent");
    }

    /// @notice The handler's writer ghost matches the chain — proving the attack path truly used
    /// non-writers, so the zero-success invariant above is meaningful.
    function invariant_WriterGhostMatchesChain() public view {
        for (uint256 i = 0; i < 4; i++) {
            address a = handler.actorAt(i);
            assertEq(reg.isWriter(a), handler.ghostWriter(a), "writer ghost drifted from chain");
        }
    }

    /// @notice Core record data is immutable after registration; only status moves, and never to NONE.
    function invariant_CoreDataImmutableStatusValid() public view {
        uint256 n = handler.count();
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = handler.hashAt(i);
            SpendIntentRegistry.IntentRecord memory rec = reg.getIntent(h);
            assertEq(rec.policyId, handler.ghostPolicyId(h), "policyId changed after registration");
            assertEq(
                rec.maxAmount, handler.ghostMaxAmount(h), "maxAmount changed after registration"
            );
            assertEq(rec.deadline, handler.ghostDeadline(h), "deadline changed after registration");
            assertTrue(
                rec.status != SpendIntentRegistry.Status.NONE, "registered intent read as NONE"
            );
        }
    }
}
