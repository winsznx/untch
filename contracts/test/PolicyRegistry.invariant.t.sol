// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { PolicyRegistry } from "../src/PolicyRegistry.sol";

/// @title PolicyRegistryHandler
/// @notice Stateful-fuzz handler (PRD §28 tier 3). Drives a bounded set of actors through random
/// sequences of register / update / pause / resume, and — critically — a stream of adversarial
/// non-owner mutation attempts. It records the owner each policy was registered with (ghost
/// state) and counts any non-owner mutation that unexpectedly succeeds; that counter must remain
/// zero forever.
contract PolicyRegistryHandler is Test {
    PolicyRegistry internal immutable REG;

    address[] internal actors;
    uint256[] internal ids;
    mapping(uint256 policyId => address registrant) public ownerOf;
    mapping(uint256 policyId => bool seen) internal known;

    /// @notice Number of non-owner mutations that succeeded. Invariant: stays 0.
    uint256 public nonOwnerSuccesses;
    /// @notice Number of adversarial non-owner attempts made (proves the attack path ran).
    uint256 public nonOwnerAttempts;

    constructor(PolicyRegistry _reg, address[] memory _actors) {
        REG = _reg;
        actors = _actors;
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function idAt(uint256 i) external view returns (uint256) {
        return ids[i];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _pick(uint256 seed) internal view returns (uint256 id, bool ok) {
        if (ids.length == 0) return (0, false);
        return (ids[seed % ids.length], true);
    }

    function register(uint256 actorSeed, address agent, bytes32 policyHash, uint64 expiry)
        external
    {
        address actor = _actor(actorSeed);
        if (agent == address(0)) agent = address(0xA9E27);
        if (policyHash == bytes32(0)) policyHash = keccak256("r");
        expiry = uint64(bound(uint256(expiry), block.timestamp + 1, type(uint64).max));

        vm.prank(actor);
        uint256 id = REG.registerPolicy(agent, policyHash, expiry);

        if (!known[id]) {
            known[id] = true;
            ownerOf[id] = actor;
            ids.push(id);
        }
    }

    function updateByOwner(uint256 pSeed, bytes32 policyHash, uint64 expiry) external {
        (uint256 id, bool ok) = _pick(pSeed);
        if (!ok) return;
        if (policyHash == bytes32(0)) policyHash = keccak256("u");
        expiry = uint64(bound(uint256(expiry), block.timestamp + 1, type(uint64).max));

        vm.prank(ownerOf[id]);
        REG.updatePolicy(id, policyHash, expiry);
    }

    function pauseByOwner(uint256 pSeed) external {
        (uint256 id, bool ok) = _pick(pSeed);
        if (!ok) return;
        if (REG.getPolicy(id).status != PolicyRegistry.PolicyStatus.ACTIVE) return;

        vm.prank(ownerOf[id]);
        REG.pausePolicy(id);
    }

    function resumeByOwner(uint256 pSeed) external {
        (uint256 id, bool ok) = _pick(pSeed);
        if (!ok) return;
        if (REG.getPolicy(id).status != PolicyRegistry.PolicyStatus.PAUSED) return;

        vm.prank(ownerOf[id]);
        REG.resumePolicy(id);
    }

    /// @notice Adversary: a non-owner tries to mutate a policy. Every attempt MUST revert; a
    /// success is recorded and will trip the invariant.
    function attackMutate(
        uint256 pSeed,
        uint256 actorSeed,
        uint8 which,
        bytes32 policyHash,
        uint64 expiry
    ) external {
        (uint256 id, bool ok) = _pick(pSeed);
        if (!ok) return;
        address attacker = _actor(actorSeed);
        if (attacker == ownerOf[id]) return; // this path only probes non-owners

        if (policyHash == bytes32(0)) policyHash = keccak256("a");
        expiry = uint64(bound(uint256(expiry), block.timestamp + 1, type(uint64).max));
        nonOwnerAttempts++;

        vm.startPrank(attacker);
        if (which % 3 == 0) {
            try REG.updatePolicy(id, policyHash, expiry) {
                nonOwnerSuccesses++;
            } catch { }
        } else if (which % 3 == 1) {
            try REG.pausePolicy(id) {
                nonOwnerSuccesses++;
            } catch { }
        } else {
            try REG.resumePolicy(id) {
                nonOwnerSuccesses++;
            } catch { }
        }
        vm.stopPrank();
    }
}

/// @title PolicyRegistryInvariant
/// @notice PRD §28 tier-3 invariants encoding the §10.1 access-control guarantees:
///   • a policy's owner NEVER changes over its lifetime (there is no ownership-transfer path);
///   • ONLY the true owner's mutating calls ever succeed;
///   • every registered policy stays in a valid {ACTIVE, PAUSED} state (never NONE, never usable
///     after being paused).
contract PolicyRegistryInvariant is Test {
    PolicyRegistry internal reg;
    PolicyRegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        reg = new PolicyRegistry();

        address[] memory actors = new address[](4);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");

        handler = new PolicyRegistryHandler(reg, actors);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.register.selector;
        selectors[1] = handler.updateByOwner.selector;
        selectors[2] = handler.pauseByOwner.selector;
        selectors[3] = handler.resumeByOwner.selector;
        selectors[4] = handler.attackMutate.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice No non-owner mutation ever succeeds.
    function invariant_OnlyOwnerCanMutate() public view {
        assertEq(handler.nonOwnerSuccesses(), 0, "a non-owner mutated a policy");
    }

    /// @notice Each policy's on-chain owner still equals the address that registered it.
    function invariant_OwnerNeverChanges() public view {
        uint256 n = handler.count();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.idAt(i);
            assertEq(reg.getPolicy(id).owner, handler.ownerOf(id), "policy owner changed");
        }
    }

    /// @notice Every registered policy is in a real lifecycle state, and a paused one is unusable.
    function invariant_StatusAlwaysValid() public view {
        uint256 n = handler.count();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.idAt(i);
            PolicyRegistry.Policy memory p = reg.getPolicy(id);
            assertTrue(
                p.status == PolicyRegistry.PolicyStatus.ACTIVE
                    || p.status == PolicyRegistry.PolicyStatus.PAUSED,
                "policy reached an invalid status"
            );
            if (p.status == PolicyRegistry.PolicyStatus.PAUSED) {
                assertFalse(reg.isUsable(id), "paused policy must not be usable");
            }
        }
    }
}
