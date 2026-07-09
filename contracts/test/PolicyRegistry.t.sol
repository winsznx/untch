// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { PolicyRegistry } from "../src/PolicyRegistry.sol";

/// @title PolicyRegistryTest
/// @notice Unit + per-function fuzz tests for PolicyRegistry (PRD §10.1, §28 test tiers 1–2).
/// Covers every function and every revert path the §10.1 function set implies, plus the two
/// documented judgment calls: policyId-from-nonce derivation and derived (never stored) expiry.
/// The single most important property — every mutating call reverts for anyone but the policy's
/// registered owner — is fuzzed here across random non-owner callers and reinforced by the
/// stateful invariant suite in PolicyRegistry.invariant.t.sol.
contract PolicyRegistryTest is Test {
    PolicyRegistry internal reg;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant HASH = keccak256("ruleset-v1");
    bytes32 internal constant HASH2 = keccak256("ruleset-v2");
    uint64 internal expiry;

    event PolicyRegistered(
        uint256 indexed policyId,
        address indexed owner,
        address indexed agent,
        bytes32 policyHash,
        uint64 expiry,
        uint32 version
    );
    event PolicyUpdated(
        uint256 indexed policyId,
        address indexed owner,
        bytes32 indexed newPolicyHash,
        bytes32 previousPolicyHash,
        uint64 newExpiry,
        uint32 version
    );
    event PolicyPaused(uint256 indexed policyId, address indexed owner);
    event PolicyResumed(uint256 indexed policyId, address indexed owner);

    function setUp() public {
        // Warp to a realistic unix second so "expiry in the past" cases have headroom below `now`.
        vm.warp(1_700_000_000);
        reg = new PolicyRegistry();
        expiry = uint64(block.timestamp + 365 days);
    }

    function _register() internal returns (uint256) {
        vm.prank(owner);
        return reg.registerPolicy(agent, HASH, expiry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // registerPolicy
    // ─────────────────────────────────────────────────────────────────────────

    function test_RegisterPolicy_StoresRecordAndEmits() public {
        uint256 expectedId = reg.previewPolicyId(owner, 0);

        vm.expectEmit(true, true, true, true, address(reg));
        emit PolicyRegistered(expectedId, owner, agent, HASH, expiry, 1);

        vm.prank(owner);
        uint256 id = reg.registerPolicy(agent, HASH, expiry);

        assertEq(id, expectedId, "returned id must equal derived id");

        PolicyRegistry.Policy memory p = reg.getPolicy(id);
        assertEq(p.owner, owner);
        assertEq(p.agent, agent);
        assertEq(p.policyHash, HASH);
        assertEq(uint8(p.status), uint8(PolicyRegistry.PolicyStatus.ACTIVE));
        assertEq(p.expiry, expiry);
        assertEq(p.version, 1);
        assertTrue(reg.exists(id));
        assertTrue(reg.isUsable(id));
    }

    function test_RegisterPolicy_IncrementsOwnerNonce() public {
        assertEq(reg.ownerNonce(owner), 0);
        _register();
        assertEq(reg.ownerNonce(owner), 1);
    }

    function test_RegisterPolicy_MultiplePoliciesSameOwnerDistinctIds() public {
        vm.startPrank(owner);
        uint256 id0 = reg.registerPolicy(agent, HASH, expiry);
        uint256 id1 = reg.registerPolicy(agent, HASH2, expiry);
        vm.stopPrank();

        assertTrue(id0 != id1, "same owner's policies must get distinct ids");
        assertEq(id0, reg.previewPolicyId(owner, 0));
        assertEq(id1, reg.previewPolicyId(owner, 1));
        assertEq(reg.ownerNonce(owner), 2);
    }

    function test_RegisterPolicy_DifferentOwnersIndependentNonces() public {
        vm.prank(owner);
        uint256 idA = reg.registerPolicy(agent, HASH, expiry);
        vm.prank(stranger);
        uint256 idB = reg.registerPolicy(agent, HASH, expiry);

        assertEq(idA, reg.previewPolicyId(owner, 0));
        assertEq(idB, reg.previewPolicyId(stranger, 0));
        assertTrue(idA != idB);
        assertEq(reg.ownerNonce(owner), 1);
        assertEq(reg.ownerNonce(stranger), 1);
    }

    function test_RegisterPolicy_ExpiryOneSecondInFutureOk() public {
        vm.prank(owner);
        uint256 id = reg.registerPolicy(agent, HASH, uint64(block.timestamp + 1));
        assertTrue(reg.isUsable(id));
    }

    function test_RevertWhen_RegisterZeroAgent() public {
        vm.prank(owner);
        vm.expectRevert(PolicyRegistry.ZeroAgent.selector);
        reg.registerPolicy(address(0), HASH, expiry);
    }

    function test_RevertWhen_RegisterZeroPolicyHash() public {
        vm.prank(owner);
        vm.expectRevert(PolicyRegistry.ZeroPolicyHash.selector);
        reg.registerPolicy(agent, bytes32(0), expiry);
    }

    function test_RevertWhen_RegisterExpiryInPast() public {
        uint64 past = uint64(block.timestamp - 1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyRegistry.ExpiryInPast.selector, past, uint64(block.timestamp)
            )
        );
        reg.registerPolicy(agent, HASH, past);
    }

    function test_RevertWhen_RegisterExpiryEqualsNow() public {
        uint64 nowTs = uint64(block.timestamp);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ExpiryInPast.selector, nowTs, nowTs));
        reg.registerPolicy(agent, HASH, nowTs);
    }

    /// @notice The defensive "never silently overwrite" guard. A natural keccak collision is
    /// infeasible to force, so we plant a record at the id the next registration will derive
    /// (via storage) and confirm the second registration reverts instead of clobbering it.
    function test_RevertWhen_DerivedIdCollides() public {
        uint256 id = reg.previewPolicyId(owner, 0);
        // _policies is state var slot 0; base slot of _policies[id] = keccak256(id, 0). The Policy
        // struct's second slot (base+1) packs agent (low 160 bits) + status (next 8). Writing
        // status = ACTIVE(1) there makes the id read as already-registered.
        bytes32 base = keccak256(abi.encode(id, uint256(0)));
        bytes32 statusSlot = bytes32(uint256(base) + 1);
        vm.store(address(reg), statusSlot, bytes32(uint256(1) << 160)); // agent=0, status=ACTIVE

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyIdCollision.selector, id));
        reg.registerPolicy(agent, HASH, expiry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // updatePolicy
    // ─────────────────────────────────────────────────────────────────────────

    function test_UpdatePolicy_BumpsVersionAndSwapsHashExpiry() public {
        uint256 id = _register();
        uint64 newExpiry = uint64(block.timestamp + 730 days);

        vm.expectEmit(true, true, true, true, address(reg));
        emit PolicyUpdated(id, owner, HASH2, HASH, newExpiry, 2);

        vm.prank(owner);
        reg.updatePolicy(id, HASH2, newExpiry);

        PolicyRegistry.Policy memory p = reg.getPolicy(id);
        assertEq(p.policyHash, HASH2);
        assertEq(p.expiry, newExpiry);
        assertEq(p.version, 2);
        assertEq(p.owner, owner, "owner must be immutable across update");
        assertEq(p.agent, agent, "agent must be immutable across update");
    }

    function test_UpdatePolicy_PreservesPausedStatus() public {
        uint256 id = _register();
        vm.prank(owner);
        reg.pausePolicy(id);

        vm.prank(owner);
        reg.updatePolicy(id, HASH2, expiry);

        PolicyRegistry.Policy memory p = reg.getPolicy(id);
        assertEq(
            uint8(p.status), uint8(PolicyRegistry.PolicyStatus.PAUSED), "update must not resume"
        );
        assertEq(p.version, 2);
    }

    function test_UpdatePolicy_VersionMonotonicAcrossManyUpdates() public {
        uint256 id = _register();
        for (uint32 i = 2; i <= 6; i++) {
            vm.prank(owner);
            reg.updatePolicy(id, keccak256(abi.encode("v", i)), expiry);
            assertEq(reg.getPolicy(id).version, i);
        }
    }

    function test_RevertWhen_UpdateNonexistentPolicy() public {
        uint256 ghost = reg.previewPolicyId(owner, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyNotFound.selector, ghost));
        reg.updatePolicy(ghost, HASH2, expiry);
    }

    function test_RevertWhen_UpdateByNonOwner() public {
        uint256 id = _register();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyRegistry.NotPolicyOwner.selector, id, stranger)
        );
        reg.updatePolicy(id, HASH2, expiry);
    }

    function test_RevertWhen_UpdateZeroPolicyHash() public {
        uint256 id = _register();
        vm.prank(owner);
        vm.expectRevert(PolicyRegistry.ZeroPolicyHash.selector);
        reg.updatePolicy(id, bytes32(0), expiry);
    }

    function test_RevertWhen_UpdateExpiryInPast() public {
        uint256 id = _register();
        uint64 past = uint64(block.timestamp - 1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyRegistry.ExpiryInPast.selector, past, uint64(block.timestamp)
            )
        );
        reg.updatePolicy(id, HASH2, past);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // pausePolicy / resumePolicy
    // ─────────────────────────────────────────────────────────────────────────

    function test_PausePolicy_ActiveToPaused() public {
        uint256 id = _register();

        vm.expectEmit(true, true, false, false, address(reg));
        emit PolicyPaused(id, owner);

        vm.prank(owner);
        reg.pausePolicy(id);

        assertEq(uint8(reg.getPolicy(id).status), uint8(PolicyRegistry.PolicyStatus.PAUSED));
        assertFalse(reg.isUsable(id));
    }

    function test_RevertWhen_PauseByNonOwner() public {
        uint256 id = _register();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyRegistry.NotPolicyOwner.selector, id, stranger)
        );
        reg.pausePolicy(id);
    }

    function test_RevertWhen_PauseNonexistent() public {
        uint256 ghost = reg.previewPolicyId(owner, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyNotFound.selector, ghost));
        reg.pausePolicy(ghost);
    }

    function test_RevertWhen_DoublePause() public {
        uint256 id = _register();
        vm.prank(owner);
        reg.pausePolicy(id);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyNotActive.selector, id));
        reg.pausePolicy(id);
    }

    function test_ResumePolicy_PausedToActive() public {
        uint256 id = _register();
        vm.prank(owner);
        reg.pausePolicy(id);

        vm.expectEmit(true, true, false, false, address(reg));
        emit PolicyResumed(id, owner);

        vm.prank(owner);
        reg.resumePolicy(id);

        assertEq(uint8(reg.getPolicy(id).status), uint8(PolicyRegistry.PolicyStatus.ACTIVE));
        assertTrue(reg.isUsable(id));
    }

    function test_RevertWhen_ResumeByNonOwner() public {
        uint256 id = _register();
        vm.prank(owner);
        reg.pausePolicy(id);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyRegistry.NotPolicyOwner.selector, id, stranger)
        );
        reg.resumePolicy(id);
    }

    function test_RevertWhen_ResumeNonexistent() public {
        uint256 ghost = reg.previewPolicyId(owner, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyNotFound.selector, ghost));
        reg.resumePolicy(ghost);
    }

    function test_RevertWhen_ResumeWhenNotPaused() public {
        uint256 id = _register();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyNotPaused.selector, id));
        reg.resumePolicy(id);
    }

    /// @notice Resume is orthogonal to expiry: a policy expired while paused flips back to ACTIVE
    /// but stays underived-unusable — proving expired-ness is derived, not a stored transition.
    function test_ResumePolicy_ExpiredPolicyStaysUnusable() public {
        uint256 id = _register();
        vm.prank(owner);
        reg.pausePolicy(id);

        vm.warp(uint256(expiry) + 1); // now strictly past expiry

        vm.prank(owner);
        reg.resumePolicy(id);

        assertEq(uint8(reg.getPolicy(id).status), uint8(PolicyRegistry.PolicyStatus.ACTIVE));
        assertFalse(reg.isUsable(id), "expired policy is unusable even when ACTIVE");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // views: getPolicy / exists / isUsable / previewPolicyId / nextPolicyId
    // ─────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_GetNonexistentPolicy() public {
        uint256 ghost = reg.previewPolicyId(owner, 7);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyNotFound.selector, ghost));
        reg.getPolicy(ghost);
    }

    function test_Exists_FalseBeforeTrueAfter() public {
        uint256 id = reg.previewPolicyId(owner, 0);
        assertFalse(reg.exists(id));
        _register();
        assertTrue(reg.exists(id));
    }

    function test_IsUsable_NonexistentIsFalse() public view {
        assertFalse(reg.isUsable(reg.previewPolicyId(owner, 0)));
    }

    function test_IsUsable_AtExactExpirySecondIsTrue() public {
        uint256 id = _register();
        vm.warp(uint256(expiry)); // block.timestamp == expiry → inclusive, still usable
        assertTrue(reg.isUsable(id));
    }

    function test_IsUsable_OneSecondPastExpiryIsFalse() public {
        uint256 id = _register();
        vm.warp(uint256(expiry) + 1);
        assertFalse(reg.isUsable(id));
    }

    function test_NextPolicyId_TracksNonce() public {
        assertEq(reg.nextPolicyId(owner), reg.previewPolicyId(owner, 0));
        _register();
        assertEq(reg.nextPolicyId(owner), reg.previewPolicyId(owner, 1));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz — policyId derivation (no collisions) + access control (always reverts)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Distinct (owner, nonce) pairs derive distinct policyIds; identical pairs match.
    function testFuzz_PreviewPolicyId_InjectiveOverPairs(
        address ownerA,
        uint256 nonceA,
        address ownerB,
        uint256 nonceB
    ) public view {
        uint256 idA = reg.previewPolicyId(ownerA, nonceA);
        uint256 idB = reg.previewPolicyId(ownerB, nonceB);
        if (ownerA == ownerB && nonceA == nonceB) {
            assertEq(idA, idB);
        } else {
            assertTrue(idA != idB, "distinct (owner,nonce) must derive distinct ids");
        }
    }

    /// @notice Whatever owner/agent/hash/expiry a caller uses, register returns exactly the id its
    /// nonce derives and stores an ACTIVE, usable record owned by the caller.
    function testFuzz_Register_ReturnsDerivedId(
        address who,
        address someAgent,
        bytes32 someHash,
        uint64 someExpiry
    ) public {
        vm.assume(who != address(0));
        vm.assume(someAgent != address(0));
        vm.assume(someHash != bytes32(0));
        someExpiry = uint64(bound(uint256(someExpiry), block.timestamp + 1, type(uint64).max));

        uint256 expected = reg.previewPolicyId(who, 0);
        vm.prank(who);
        uint256 id = reg.registerPolicy(someAgent, someHash, someExpiry);

        assertEq(id, expected);
        PolicyRegistry.Policy memory p = reg.getPolicy(id);
        assertEq(p.owner, who);
        assertEq(p.agent, someAgent);
        assertEq(uint8(p.status), uint8(PolicyRegistry.PolicyStatus.ACTIVE));
    }

    /// @notice Access control is total: no non-owner can update, pause, or resume a policy.
    function testFuzz_NonOwnerCannotMutate(address caller) public {
        uint256 id = _register();
        vm.assume(caller != owner);

        bytes memory notOwner =
            abi.encodeWithSelector(PolicyRegistry.NotPolicyOwner.selector, id, caller);

        vm.prank(caller);
        vm.expectRevert(notOwner);
        reg.updatePolicy(id, HASH2, expiry);

        vm.prank(caller);
        vm.expectRevert(notOwner);
        reg.pausePolicy(id);

        // Put it in PAUSED so resume's owner-check is what rejects the caller (not a state check).
        vm.prank(owner);
        reg.pausePolicy(id);
        vm.prank(caller);
        vm.expectRevert(notOwner);
        reg.resumePolicy(id);
    }

    /// @notice Registering N policies from one owner yields N distinct ids and a nonce of N.
    function testFuzz_ManyRegistrationsNonceMonotonic(uint8 n) public {
        n = uint8(bound(n, 1, 24));
        uint256 prev;
        for (uint256 i = 0; i < n; i++) {
            assertEq(reg.ownerNonce(owner), i);
            vm.prank(owner);
            uint256 id = reg.registerPolicy(agent, keccak256(abi.encode(i)), expiry);
            assertEq(id, reg.previewPolicyId(owner, i));
            if (i > 0) assertTrue(id != prev);
            prev = id;
        }
        assertEq(reg.ownerNonce(owner), n);
    }

    /// @notice isUsable exactly tracks ACTIVE ∧ now ≤ expiry across arbitrary clocks.
    function testFuzz_IsUsable_MatchesDerivedRule(uint64 someExpiry, uint256 warpTo) public {
        someExpiry = uint64(bound(uint256(someExpiry), block.timestamp + 1, type(uint64).max));
        vm.prank(owner);
        uint256 id = reg.registerPolicy(agent, HASH, someExpiry);

        warpTo = bound(warpTo, 1, type(uint64).max);
        vm.warp(warpTo);

        assertEq(
            reg.isUsable(id), warpTo <= someExpiry, "isUsable must equal now<=expiry when ACTIVE"
        );
    }
}
