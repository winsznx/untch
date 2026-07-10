// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { UntchVault } from "../src/UntchVault.sol";
import { UntchVaultFactory } from "../src/UntchVaultFactory.sol";
import { MockIntentRegistry } from "./mocks/VaultMocks.sol";

/// @title UntchVaultFactoryTest
/// @notice Unit + fuzz tests for UntchVaultFactory (PRD §10.4, §28 tiers 1–2). Covers: the reconciled
/// §10.4 signature and canonical-`intentRegistry` wiring (decisions A/B); deployed-vault immutables read
/// back and MATCHED against the inputs (constructor-argument-correctness — not merely "it deployed");
/// `computeVaultAddress` == the real deployed address; double-deployment to the same `(owner, agent)`
/// reverting via CREATE2's natural collision; the `owner == msg.sender` access control (decision C); the
/// salt binding `(owner, agent)` so the same agent under different owners gets distinct vaults; and the
/// fuzz proof that prediction always equals deployment across random inputs.
contract UntchVaultFactoryTest is Test {
    UntchVaultFactory internal factory;
    MockIntentRegistry internal registry;

    address internal owner;
    address internal agent = makeAddr("agent");
    address internal oracle = makeAddr("oracle");
    address internal tokenA = makeAddr("tokenA");
    address internal tokenB = makeAddr("tokenB");

    uint256 internal constant PER_TX_CAP = 100e6;
    uint256 internal constant EPOCH_BUDGET = 250e6;
    uint64 internal constant EPOCH_LEN = 1 days;

    event VaultDeployed(
        address indexed owner,
        address indexed agent,
        address indexed vault,
        address oracle,
        bool requireAnchoredIntent
    );

    function setUp() public {
        owner = address(this);
        registry = new MockIntentRegistry();
        factory = new UntchVaultFactory(address(registry));
    }

    function _allow() internal view returns (address[] memory allow) {
        allow = new address[](2);
        allow[0] = tokenA;
        allow[1] = tokenB;
    }

    function _deploy(address who, address a, bool requireIntent) internal returns (address vault) {
        vm.prank(who);
        vault = factory.deployVault(
            who, a, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), requireIntent
        );
    }

    // ── constructor ──────────────────────────────────────────────────────────

    function test_Constructor_SetsCanonicalRegistry() public view {
        assertEq(factory.intentRegistry(), address(registry));
    }

    function test_Constructor_RevertsOnZeroRegistry() public {
        vm.expectRevert(UntchVaultFactory.ZeroAddress.selector);
        new UntchVaultFactory(address(0));
    }

    // ── deployVault: wiring correctness (read the immutables back, MATCH the inputs) ──

    function test_DeployVault_WiresEveryImmutableFromInputs() public {
        address predicted = factory.computeVaultAddress(
            owner, agent, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );

        vm.expectEmit(true, true, true, true);
        emit VaultDeployed(owner, agent, predicted, oracle, true);
        address vaultAddr = _deploy(owner, agent, true);

        UntchVault vault = UntchVault(vaultAddr);
        assertEq(vault.owner(), owner, "owner");
        assertEq(vault.oracle(), oracle, "oracle");
        // intentRegistry is the FACTORY's canonical one (decision B), never a per-call value.
        assertEq(address(vault.intentRegistry()), address(registry), "intentRegistry");
        assertEq(vault.perTxCap(), PER_TX_CAP, "perTxCap");
        assertEq(vault.epochBudget(), EPOCH_BUDGET, "epochBudget");
        assertEq(vault.epochLen(), EPOCH_LEN, "epochLen");
        assertTrue(vault.requireAnchoredIntent(), "requireAnchoredIntent");
        assertTrue(vault.tokenAllowed(tokenA), "tokenA allowed");
        assertTrue(vault.tokenAllowed(tokenB), "tokenB allowed");
        assertFalse(vault.tokenAllowed(oracle), "non-listed token not allowed");
    }

    function test_DeployVault_RequireAnchoredIntentFalse_StillWiresCanonicalRegistry() public {
        address vaultAddr = _deploy(owner, agent, false);
        UntchVault vault = UntchVault(vaultAddr);
        assertFalse(vault.requireAnchoredIntent());
        // Even when unused, the canonical registry is still wired (harmless — never called).
        assertEq(address(vault.intentRegistry()), address(registry));
    }

    // ── computeVaultAddress == real deployed address ───────────────────────────

    function test_ComputeVaultAddress_MatchesDeployment() public {
        address predicted = factory.computeVaultAddress(
            owner, agent, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
        address actual = _deploy(owner, agent, true);
        assertEq(actual, predicted, "prediction must equal deployment");
        assertGt(actual.code.length, 0, "deployed address must hold code");
    }

    /// @dev Anti-tampering: the predicted address COMMITS to every constructor argument. Changing any of
    /// them (here: oracle, then a cap, then requireAnchoredIntent) changes the address — so a caller
    /// cannot predict with one config and have a vault with a DIFFERENT config land at that address.
    function test_ComputeVaultAddress_CommitsToConstructorArgs() public view {
        address base = factory.computeVaultAddress(
            owner, agent, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
        address diffOracle = factory.computeVaultAddress(
            owner, agent, address(0xdead), PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
        address diffCap = factory.computeVaultAddress(
            owner, agent, oracle, PER_TX_CAP + 1, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
        address diffFlag = factory.computeVaultAddress(
            owner, agent, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), false
        );
        assertTrue(base != diffOracle, "oracle must affect address");
        assertTrue(base != diffCap, "perTxCap must affect address");
        assertTrue(base != diffFlag, "requireAnchoredIntent must affect address");
    }

    // ── double-deployment: same (owner, agent) reverts (CREATE2 natural collision) ──

    function test_DeployVault_DoubleDeploySamePairReverts() public {
        _deploy(owner, agent, true);
        // Second deployment to the SAME (owner, agent) with the SAME config: the CREATE2 target already
        // holds code, so `create2` returns the zero address (its natural collision signal) and the factory
        // surfaces the clear, named reason. No bespoke pre-check — the failure is classified after the
        // deployment attempt.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(UntchVaultFactory.VaultAlreadyDeployed.selector, owner, agent)
        );
        factory.deployVault(
            owner, agent, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
    }

    /// @dev HONEST NUANCE (not papered over): CREATE2's address commits to the FULL initcode, and the
    /// vault's config is part of it, so the same (owner, agent) with a DIFFERENT config produces a
    /// DIFFERENT address — CREATE2 cannot collide distinct initcode, and no salt scheme can change that
    /// while the vault stores config as constructor immutables. Access control (owner == msg.sender) means
    /// only `owner` itself could ever create such a variant of its OWN vault, so this is not a third-party
    /// griefing surface. This test documents that real behavior rather than asserting a guarantee the EVM
    /// cannot provide here.
    function test_DeployVault_SamePairDifferentConfigLandsElsewhere() public {
        address first = _deploy(owner, agent, true);
        vm.prank(owner);
        address second = factory.deployVault(
            owner, agent, address(0xbeef), PER_TX_CAP * 2, EPOCH_BUDGET, EPOCH_LEN, _allow(), false
        );
        assertTrue(first != second, "distinct config -> distinct CREATE2 address");
        assertEq(UntchVault(first).owner(), owner);
        assertEq(UntchVault(second).owner(), owner);
    }

    // ── access control (decision C) ────────────────────────────────────────────

    function test_DeployVault_RevertsWhenOwnerIsNotCaller() public {
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(UntchVaultFactory.OwnerMustBeSender.selector, owner, mallory)
        );
        factory.deployVault(
            owner, agent, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
    }

    function test_DeployVault_PermissionlessForOnesOwnVault() public {
        // Any account may deploy — as long as it owns the result. Two distinct callers each deploy their
        // own vault with no gatekeeper.
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        address aliceVault = _deploy(alice, agent, true);
        address bobVault = _deploy(bob, agent, true);
        assertEq(UntchVault(aliceVault).owner(), alice);
        assertEq(UntchVault(bobVault).owner(), bob);
        assertTrue(aliceVault != bobVault);
    }

    function test_DeployVault_RevertsOnZeroAgent() public {
        vm.prank(owner);
        vm.expectRevert(UntchVaultFactory.ZeroAddress.selector);
        factory.deployVault(
            owner, address(0), oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
    }

    // ── salt semantics: (owner, agent) is the uniqueness key ────────────────────

    function test_Salt_SameAgentDifferentOwnerGivesDistinctVaults() public {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        assertTrue(_deploy(alice, agent, true) != _deploy(bob, agent, true));
    }

    function test_Salt_SameOwnerDifferentAgentGivesDistinctVaults() public {
        address agent2 = makeAddr("agent2");
        assertTrue(_deploy(owner, agent, true) != _deploy(owner, agent2, true));
    }

    // ── invalid vault args → create2 zero-return, surfaced as VaultDeploymentFailed ──
    // `create2` discards a creation-revert's data, so the vault's own specific reason (ZeroAddress /
    // ZeroValue / EmptyTokenAllowlist) is not recoverable; the factory reports the generic, distinct-from-
    // collision `VaultDeploymentFailed`. Each case still reverts (bad args never deploy a vault).

    function _expectDeployFailed() internal {
        vm.expectRevert(
            abi.encodeWithSelector(UntchVaultFactory.VaultDeploymentFailed.selector, owner, agent)
        );
    }

    function test_DeployVault_ZeroOracleReverts() public {
        vm.prank(owner);
        _expectDeployFailed();
        factory.deployVault(
            owner, agent, address(0), PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, _allow(), true
        );
    }

    function test_DeployVault_ZeroCapReverts() public {
        vm.prank(owner);
        _expectDeployFailed();
        factory.deployVault(owner, agent, oracle, 0, EPOCH_BUDGET, EPOCH_LEN, _allow(), true);
    }

    function test_DeployVault_EmptyAllowlistReverts() public {
        address[] memory empty = new address[](0);
        vm.prank(owner);
        _expectDeployFailed();
        factory.deployVault(owner, agent, oracle, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, empty, true);
    }

    // ── fuzz: prediction ALWAYS equals deployment across random inputs (§10.4 step 4) ──

    function testFuzz_ComputeVaultAddressMatchesDeployment(
        address fuzzOwner,
        address fuzzAgent,
        address fuzzOracle,
        uint256 perTxCap,
        uint256 epochBudget,
        uint64 epochLenSecs,
        address fuzzToken,
        bool requireIntent
    ) public {
        // Constrain to inputs the vault constructor accepts (else `new` reverts for an unrelated reason).
        vm.assume(fuzzOwner != address(0));
        vm.assume(fuzzAgent != address(0));
        vm.assume(fuzzOracle != address(0));
        vm.assume(fuzzToken != address(0));
        perTxCap = bound(perTxCap, 1, type(uint256).max);
        epochBudget = bound(epochBudget, 1, type(uint256).max);
        epochLenSecs = uint64(bound(epochLenSecs, 1, type(uint64).max));

        address[] memory allow = new address[](1);
        allow[0] = fuzzToken;

        address predicted = factory.computeVaultAddress(
            fuzzOwner,
            fuzzAgent,
            fuzzOracle,
            perTxCap,
            epochBudget,
            epochLenSecs,
            allow,
            requireIntent
        );

        vm.prank(fuzzOwner);
        address actual = factory.deployVault(
            fuzzOwner,
            fuzzAgent,
            fuzzOracle,
            perTxCap,
            epochBudget,
            epochLenSecs,
            allow,
            requireIntent
        );

        assertEq(actual, predicted, "fuzz: prediction must equal deployment");
        // And the deployment genuinely wired the fuzzed inputs (spot-check the sovereign + canonical reg).
        assertEq(UntchVault(actual).owner(), fuzzOwner);
        assertEq(address(UntchVault(actual).intentRegistry()), address(registry));
    }
}
