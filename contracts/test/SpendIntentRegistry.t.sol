// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { SpendIntentRegistry } from "../src/SpendIntentRegistry.sol";
import { IntentHash } from "../src/lib/IntentHash.sol";

/// @title SpendIntentRegistryTest
/// @notice Unit + per-function fuzz tests for SpendIntentRegistry (PRD §10.2, §28 test tiers 1–2).
/// Covers every function and every revert path the §10.2 function set implies, plus the three
/// documented decisions: authorized-writer-set access control (NOT owner-gating), the on-chain
/// intentHash-from-struct derivation (no caller-supplied hash), and the derived (never stored)
/// expiry with a {NONE, PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED} status enum.
/// The single most important properties — the on-chain hash always equals what the shared library
/// (and thus canon) produces, and only authorized writers can ever mutate — are fuzzed here across
/// random structs and random non-writer callers, and reinforced by the stateful invariant suite in
/// SpendIntentRegistry.invariant.t.sol.
contract SpendIntentRegistryTest is Test {
    SpendIntentRegistry internal reg;

    address internal writer = makeAddr("writer");
    address internal stranger = makeAddr("stranger");
    address internal newAdmin = makeAddr("newAdmin");
    address internal operator = makeAddr("operator");
    address internal tokenAddr = makeAddr("token");

    uint256 internal constant POLICY_ID = 42;
    uint64 internal deadline;

    event IntentRegistered(
        bytes32 indexed intentHash,
        uint256 indexed policyId,
        address indexed owner,
        uint256 maxAmount,
        uint64 deadline
    );
    event IntentStatusChanged(
        bytes32 indexed intentHash,
        SpendIntentRegistry.Status indexed newStatus,
        address indexed writer,
        SpendIntentRegistry.Status previousStatus
    );
    event WriterAdded(address indexed writer, address indexed admin);
    event WriterRemoved(address indexed writer, address indexed admin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    function setUp() public {
        // Warp to a realistic unix second so "deadline in the past" cases have headroom below `now`.
        vm.warp(1_700_000_000);
        reg = new SpendIntentRegistry(); // admin = this test contract
        reg.addWriter(writer);
        deadline = uint64(block.timestamp + 30 days);
    }

    /// @dev A structurally-real §8.1 SpendIntent. `nonce` lets callers derive distinct intents.
    function _intent(uint256 nonce) internal view returns (IntentHash.SpendIntent memory) {
        return IntentHash.SpendIntent({
            owner: operator,
            buyerAgentId: 7,
            workerAgentId: 0,
            token: tokenAddr,
            maxAmount: 1_000_000,
            taskHash: keccak256("task"),
            acceptanceHash: keccak256("acceptance"),
            schemaHash: keccak256("schema"),
            policyHash: keccak256("policy"),
            deadline: deadline,
            nonce: nonce
        });
    }

    function _register(uint256 nonce) internal returns (bytes32) {
        vm.prank(writer);
        return reg.registerIntent(_intent(nonce), POLICY_ID);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // constructor / admin bootstrap
    // ─────────────────────────────────────────────────────────────────────────

    function test_Constructor_SetsDeployerAdminNotWriter() public view {
        assertEq(reg.admin(), address(this), "deployer is admin");
        assertFalse(
            reg.isWriter(address(this)), "admin is not a writer by default (least privilege)"
        );
        assertTrue(reg.isWriter(writer), "explicitly-added writer is authorized");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // registerIntent
    // ─────────────────────────────────────────────────────────────────────────

    function test_RegisterIntent_StoresRecordAndEmits() public {
        IntentHash.SpendIntent memory intent = _intent(1);
        bytes32 expectedHash = IntentHash.hashIntent(intent);

        vm.expectEmit(true, true, true, true, address(reg));
        emit IntentRegistered(expectedHash, POLICY_ID, intent.owner, intent.maxAmount, deadline);

        vm.prank(writer);
        bytes32 h = reg.registerIntent(intent, POLICY_ID);

        assertEq(h, expectedHash, "returned hash must equal the library-derived hash");

        SpendIntentRegistry.IntentRecord memory rec = reg.getIntent(h);
        assertEq(rec.policyId, POLICY_ID);
        assertEq(rec.maxAmount, intent.maxAmount);
        assertEq(rec.deadline, deadline);
        assertEq(uint8(rec.status), uint8(SpendIntentRegistry.Status.PENDING), "born PENDING");
        assertTrue(reg.exists(h));
        assertFalse(reg.isExpired(h), "fresh intent is not expired");
        assertFalse(reg.isUsable(h), "PENDING intent is not usable (not APPROVED)");
    }

    function test_RegisterIntent_HashIsDerivedFromStruct_NotSuppliable() public {
        // There is no interface path to supply a hash: registerIntent only accepts the struct, so the
        // stored key is provably the library hash of exactly the fields registered.
        IntentHash.SpendIntent memory intent = _intent(3);
        vm.prank(writer);
        bytes32 h = reg.registerIntent(intent, POLICY_ID);
        assertEq(h, IntentHash.hashIntent(intent));
        assertEq(h, reg.previewIntentHash(intent));
    }

    function test_RevertWhen_RegisterByNonWriter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotWriter.selector, stranger));
        reg.registerIntent(_intent(1), POLICY_ID);
    }

    function test_RevertWhen_RegisterZeroPolicyId() public {
        vm.prank(writer);
        vm.expectRevert(SpendIntentRegistry.ZeroPolicyId.selector);
        reg.registerIntent(_intent(1), 0);
    }

    function test_RevertWhen_RegisterDeadlineInPast() public {
        IntentHash.SpendIntent memory intent = _intent(1);
        uint64 past = uint64(block.timestamp - 1);
        intent.deadline = past;
        vm.prank(writer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendIntentRegistry.DeadlineInPast.selector, past, uint64(block.timestamp)
            )
        );
        reg.registerIntent(intent, POLICY_ID);
    }

    function test_RevertWhen_RegisterDeadlineEqualsNow() public {
        IntentHash.SpendIntent memory intent = _intent(1);
        uint64 nowTs = uint64(block.timestamp);
        intent.deadline = nowTs;
        vm.prank(writer);
        vm.expectRevert(
            abi.encodeWithSelector(SpendIntentRegistry.DeadlineInPast.selector, nowTs, nowTs)
        );
        reg.registerIntent(intent, POLICY_ID);
    }

    function test_RevertWhen_RegisterDeadlineTooFar() public {
        IntentHash.SpendIntent memory intent = _intent(1);
        uint256 tooFar = uint256(type(uint64).max) + 1;
        intent.deadline = tooFar;
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.DeadlineTooFar.selector, tooFar));
        reg.registerIntent(intent, POLICY_ID);
    }

    function test_RegisterIntent_DeadlineAtUint64MaxOk() public {
        IntentHash.SpendIntent memory intent = _intent(1);
        intent.deadline = uint256(type(uint64).max);
        vm.prank(writer);
        bytes32 h = reg.registerIntent(intent, POLICY_ID);
        assertEq(reg.getIntent(h).deadline, type(uint64).max, "max uint64 deadline stored exactly");
    }

    function test_RevertWhen_RegisterSameIntentTwice() public {
        IntentHash.SpendIntent memory intent = _intent(1);
        vm.prank(writer);
        bytes32 h = reg.registerIntent(intent, POLICY_ID);

        vm.prank(writer);
        vm.expectRevert(
            abi.encodeWithSelector(SpendIntentRegistry.IntentAlreadyRegistered.selector, h)
        );
        reg.registerIntent(intent, POLICY_ID);
    }

    function test_RegisterIntent_DifferentNonceDistinctHashes() public {
        bytes32 h0 = _register(0);
        bytes32 h1 = _register(1);
        assertTrue(h0 != h1, "intents differing only in nonce get distinct hashes");
        assertTrue(reg.exists(h0) && reg.exists(h1));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setStatus
    // ─────────────────────────────────────────────────────────────────────────

    function test_SetStatus_TransitionsAndEmits() public {
        bytes32 h = _register(1);

        vm.expectEmit(true, true, true, true, address(reg));
        emit IntentStatusChanged(
            h, SpendIntentRegistry.Status.APPROVED, writer, SpendIntentRegistry.Status.PENDING
        );

        vm.prank(writer);
        reg.setStatus(h, SpendIntentRegistry.Status.APPROVED);

        assertEq(uint8(reg.getIntent(h).status), uint8(SpendIntentRegistry.Status.APPROVED));
        assertTrue(reg.isUsable(h), "APPROVED + not expired => usable");
    }

    /// @notice Every real lifecycle status is reachable via setStatus (no on-chain DAG, decision #3),
    /// and the core record data never changes across any transition — only status moves.
    function test_SetStatus_AllLifecycleStatesReachable_CoreDataImmutable() public {
        bytes32 h = _register(1);
        SpendIntentRegistry.IntentRecord memory before = reg.getIntent(h);

        SpendIntentRegistry.Status[5] memory states = [
            SpendIntentRegistry.Status.PENDING,
            SpendIntentRegistry.Status.APPROVED,
            SpendIntentRegistry.Status.BLOCKED,
            SpendIntentRegistry.Status.SETTLED,
            SpendIntentRegistry.Status.DISPUTED
        ];
        for (uint256 i = 0; i < states.length; i++) {
            vm.prank(writer);
            reg.setStatus(h, states[i]);
            SpendIntentRegistry.IntentRecord memory rec = reg.getIntent(h);
            assertEq(uint8(rec.status), uint8(states[i]), "status set");
            assertEq(rec.policyId, before.policyId, "policyId immutable");
            assertEq(rec.maxAmount, before.maxAmount, "maxAmount immutable");
            assertEq(rec.deadline, before.deadline, "deadline immutable");
        }
    }

    function test_RevertWhen_SetStatusByNonWriter() public {
        bytes32 h = _register(1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotWriter.selector, stranger));
        reg.setStatus(h, SpendIntentRegistry.Status.APPROVED);
    }

    function test_RevertWhen_SetStatusNonexistent() public {
        bytes32 ghost = keccak256("no-such-intent");
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.IntentNotFound.selector, ghost));
        reg.setStatus(ghost, SpendIntentRegistry.Status.APPROVED);
    }

    function test_RevertWhen_SetStatusToNone() public {
        bytes32 h = _register(1);
        vm.prank(writer);
        vm.expectRevert(SpendIntentRegistry.StatusCannotBeNone.selector);
        reg.setStatus(h, SpendIntentRegistry.Status.NONE);
    }

    /// @notice Setting NONE on a nonexistent intent reverts on the NONE guard first (the guard runs
    /// before the existence check), so a writer can never use setStatus to probe/mutate the sentinel.
    function test_RevertWhen_SetStatusToNoneOnNonexistent() public {
        vm.prank(writer);
        vm.expectRevert(SpendIntentRegistry.StatusCannotBeNone.selector);
        reg.setStatus(keccak256("ghost"), SpendIntentRegistry.Status.NONE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // writer set / admin
    // ─────────────────────────────────────────────────────────────────────────

    function test_AddWriter_AuthorizesAndEmits() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit WriterAdded(stranger, address(this));
        reg.addWriter(stranger);
        assertTrue(reg.isWriter(stranger));
    }

    function test_RevertWhen_AddWriterByNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotAdmin.selector, stranger));
        reg.addWriter(stranger);
    }

    function test_RevertWhen_AddWriterZeroAddress() public {
        vm.expectRevert(SpendIntentRegistry.ZeroAddress.selector);
        reg.addWriter(address(0));
    }

    function test_RevertWhen_AddWriterAlreadyAuthorized() public {
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.AlreadyWriter.selector, writer));
        reg.addWriter(writer);
    }

    function test_RemoveWriter_DeauthorizesAndBlocksRegister() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit WriterRemoved(writer, address(this));
        reg.removeWriter(writer);
        assertFalse(reg.isWriter(writer));

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotWriter.selector, writer));
        reg.registerIntent(_intent(1), POLICY_ID);
    }

    function test_RevertWhen_RemoveWriterNotAuthorized() public {
        vm.expectRevert(
            abi.encodeWithSelector(SpendIntentRegistry.NotAuthorizedWriter.selector, stranger)
        );
        reg.removeWriter(stranger);
    }

    function test_RevertWhen_RemoveWriterByNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotAdmin.selector, stranger));
        reg.removeWriter(writer);
    }

    function test_TransferAdmin_MovesRoleAndRevokesOld() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit AdminTransferred(address(this), newAdmin);
        reg.transferAdmin(newAdmin);
        assertEq(reg.admin(), newAdmin);

        // old admin can no longer manage writers
        vm.expectRevert(
            abi.encodeWithSelector(SpendIntentRegistry.NotAdmin.selector, address(this))
        );
        reg.addWriter(stranger);

        // new admin can
        vm.prank(newAdmin);
        reg.addWriter(stranger);
        assertTrue(reg.isWriter(stranger));
    }

    function test_RevertWhen_TransferAdminZeroAddress() public {
        vm.expectRevert(SpendIntentRegistry.ZeroAddress.selector);
        reg.transferAdmin(address(0));
    }

    function test_RevertWhen_TransferAdminByNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotAdmin.selector, stranger));
        reg.transferAdmin(stranger);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // views: getIntent / exists / isExpired / isUsable / previewIntentHash
    // ─────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_GetNonexistentIntent() public {
        bytes32 ghost = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.IntentNotFound.selector, ghost));
        reg.getIntent(ghost);
    }

    function test_Exists_FalseBeforeTrueAfter() public {
        bytes32 h = IntentHash.hashIntent(_intent(9));
        assertFalse(reg.exists(h));
        _register(9);
        assertTrue(reg.exists(h));
    }

    function test_IsExpired_NonexistentReadsExpired() public view {
        assertTrue(
            reg.isExpired(keccak256("ghost")), "unknown intent (deadline 0) reads as expired"
        );
    }

    function test_IsExpired_AtExactDeadlineIsFalse() public {
        bytes32 h = _register(1);
        vm.warp(uint256(deadline)); // now == deadline → inclusive, not yet expired
        assertFalse(reg.isExpired(h));
    }

    function test_IsExpired_OneSecondPastDeadlineIsTrue() public {
        bytes32 h = _register(1);
        vm.warp(uint256(deadline) + 1);
        assertTrue(reg.isExpired(h));
    }

    function test_IsUsable_ApprovedThenExpiredBecomesUnusable() public {
        bytes32 h = _register(1);
        vm.prank(writer);
        reg.setStatus(h, SpendIntentRegistry.Status.APPROVED);
        assertTrue(reg.isUsable(h));

        vm.warp(uint256(deadline) + 1);
        assertFalse(reg.isUsable(h), "APPROVED but past deadline => not usable (derived expiry)");
    }

    function test_IsUsable_BlockedIsNeverUsable() public {
        bytes32 h = _register(1);
        vm.prank(writer);
        reg.setStatus(h, SpendIntentRegistry.Status.BLOCKED);
        assertFalse(reg.isUsable(h));
    }

    function test_IsUsable_NonexistentIsFalse() public view {
        assertFalse(reg.isUsable(keccak256("ghost")));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz — hash-derivation consistency (differential) + access-control totality
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The registry's on-chain hash for any struct equals the shared library's hash AND an
    /// independent in-test recomputation of canon's exact formula: keccak256(abi.encode(<§8.1 fields,
    /// in declared order>)). This is the SpendIntentRegistry half of the D0.5 differential — the
    /// fixture-based IntentHash.t.sol proves the library equals canon over the shared corpus; this
    /// proves the registry preserves that library hash across arbitrary field combinations.
    function testFuzz_RegistryHashEqualsLibraryAndCanonFormula(
        address owner,
        uint256 buyerAgentId,
        uint256 workerAgentId,
        address token,
        uint256 maxAmount,
        bytes32 taskHash,
        bytes32 acceptanceHash,
        bytes32 schemaHash,
        bytes32 policyHash,
        uint256 dl,
        uint256 nonce
    ) public view {
        IntentHash.SpendIntent memory intent = IntentHash.SpendIntent({
            owner: owner,
            buyerAgentId: buyerAgentId,
            workerAgentId: workerAgentId,
            token: token,
            maxAmount: maxAmount,
            taskHash: taskHash,
            acceptanceHash: acceptanceHash,
            schemaHash: schemaHash,
            policyHash: policyHash,
            deadline: dl,
            nonce: nonce
        });

        bytes32 canonFormula = keccak256(
            abi.encode(
                owner,
                buyerAgentId,
                workerAgentId,
                token,
                maxAmount,
                taskHash,
                acceptanceHash,
                schemaHash,
                policyHash,
                dl,
                nonce
            )
        );

        assertEq(
            reg.previewIntentHash(intent), IntentHash.hashIntent(intent), "registry != library"
        );
        assertEq(
            reg.previewIntentHash(intent), canonFormula, "registry != canon abi.encode formula"
        );
    }

    /// @notice Registering under the fuzzed struct keys the record by exactly the library hash.
    function testFuzz_RegisterStoresUnderLibraryHash(
        uint256 policyId,
        uint256 maxAmount,
        uint64 dl,
        uint256 nonce
    ) public {
        policyId = bound(policyId, 1, type(uint256).max);
        dl = uint64(bound(uint256(dl), block.timestamp + 1, type(uint64).max));

        IntentHash.SpendIntent memory intent = _intent(nonce);
        intent.maxAmount = maxAmount;
        intent.deadline = dl;

        bytes32 expected = IntentHash.hashIntent(intent);
        vm.prank(writer);
        bytes32 h = reg.registerIntent(intent, policyId);

        assertEq(h, expected);
        SpendIntentRegistry.IntentRecord memory rec = reg.getIntent(h);
        assertEq(rec.policyId, policyId);
        assertEq(rec.maxAmount, maxAmount);
        assertEq(rec.deadline, dl);
        assertEq(uint8(rec.status), uint8(SpendIntentRegistry.Status.PENDING));
    }

    /// @dev A fixed §8.1 struct built fresh each call. Two calls return INDEPENDENT memory structs
    /// (`= a` would alias, since a memory struct is a reference), which the sensitivity fuzz needs.
    function _fixedIntent() internal pure returns (IntentHash.SpendIntent memory) {
        return IntentHash.SpendIntent({
            owner: address(0xA11CE),
            buyerAgentId: 1,
            workerAgentId: 2,
            token: address(0xB0B),
            maxAmount: 3,
            taskHash: bytes32(uint256(4)),
            acceptanceHash: bytes32(uint256(5)),
            schemaHash: bytes32(uint256(6)),
            policyHash: bytes32(uint256(7)),
            deadline: 8,
            nonce: 9
        });
    }

    /// @notice Mutating any single §8.1 field changes the hash — pins that no field is dropped from
    /// the derivation (the field-order/coverage guarantee the D0.5 differential also protects).
    function testFuzz_AnyFieldChangeChangesHash(uint8 fieldIdx, uint256 delta) public pure {
        vm.assume(delta != 0);
        fieldIdx = uint8(bound(fieldIdx, 0, 10));

        IntentHash.SpendIntent memory a = _fixedIntent();
        IntentHash.SpendIntent memory b = _fixedIntent();

        // Each branch changes `b` in exactly one field vs `a`: the two 160-bit address fields flip to
        // a fixed distinct address (no truncating cast), the wide integer/bytes32 fields XOR a non-zero
        // delta, and the uint64 deadline flips its low bit. So the hash inequality can be asserted
        // unconditionally — no field may be silently dropped from the derivation.
        if (fieldIdx == 0) b.owner = address(0xBEEF);
        else if (fieldIdx == 1) b.buyerAgentId = a.buyerAgentId ^ delta;
        else if (fieldIdx == 2) b.workerAgentId = a.workerAgentId ^ delta;
        else if (fieldIdx == 3) b.token = address(0xF00D);
        else if (fieldIdx == 4) b.maxAmount = a.maxAmount ^ delta;
        else if (fieldIdx == 5) b.taskHash = bytes32(uint256(a.taskHash) ^ delta);
        else if (fieldIdx == 6) b.acceptanceHash = bytes32(uint256(a.acceptanceHash) ^ delta);
        else if (fieldIdx == 7) b.schemaHash = bytes32(uint256(a.schemaHash) ^ delta);
        else if (fieldIdx == 8) b.policyHash = bytes32(uint256(a.policyHash) ^ delta);
        else if (fieldIdx == 9) b.deadline = a.deadline ^ 1;
        else b.nonce = a.nonce ^ delta;

        assertTrue(
            IntentHash.hashIntent(b) != IntentHash.hashIntent(a), "distinct struct => distinct hash"
        );
    }

    /// @notice Access control is total for registration: no non-writer can register, whatever the caller.
    function testFuzz_NonWriterCannotRegister(address caller) public {
        vm.assume(caller != writer);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotWriter.selector, caller));
        reg.registerIntent(_intent(1), POLICY_ID);
    }

    /// @notice Access control is total for status transitions: no non-writer can setStatus.
    function testFuzz_NonWriterCannotSetStatus(address caller) public {
        bytes32 h = _register(1);
        vm.assume(caller != writer);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(SpendIntentRegistry.NotWriter.selector, caller));
        reg.setStatus(h, SpendIntentRegistry.Status.APPROVED);
    }

    /// @notice Access control is total for admin ops: no non-admin can add/remove writers or transfer.
    function testFuzz_NonAdminCannotManage(address caller) public {
        vm.assume(caller != address(this));
        bytes memory notAdmin =
            abi.encodeWithSelector(SpendIntentRegistry.NotAdmin.selector, caller);

        vm.prank(caller);
        vm.expectRevert(notAdmin);
        reg.addWriter(caller);

        vm.prank(caller);
        vm.expectRevert(notAdmin);
        reg.removeWriter(writer);

        vm.prank(caller);
        vm.expectRevert(notAdmin);
        reg.transferAdmin(caller);
    }

    /// @notice Registering N intents from a writer yields N distinct, all-existing hashes.
    function testFuzz_ManyRegistrationsDistinct(uint8 n) public {
        n = uint8(bound(n, 1, 24));
        bytes32 prev;
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = _register(i);
            assertTrue(reg.exists(h));
            if (i > 0) assertTrue(h != prev);
            prev = h;
        }
    }
}
