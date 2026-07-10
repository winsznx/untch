// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { UntchVault, ISpendIntentStatus } from "../src/UntchVault.sol";
import {
    MockERC20,
    MockERC20NoReturn,
    ReentrantToken,
    CEIProbeToken,
    MockIntentRegistry,
    RevertingRegistry,
    EmptyReturnRegistry,
    GarbageReturnRegistry
} from "./mocks/VaultMocks.sol";

/// @title UntchVaultTest
/// @notice Unit + per-function fuzz tests for UntchVault (PRD §10.4 / §7.5, §28 tiers 1–2, 4). Every
/// function and every §7.5 revert path is a named test — VaultPaused, SigExpired, NonceReplay,
/// BadOracle, CapExceeded, BudgetExceeded, TokenNotAllowed, IntentNotApproved — plus the two fallback /
/// withdraw / admin surfaces, the six judgment calls (chainId dynamism, malleability rejection,
/// cross-contract fail-closed, CEI/reentrancy, immutable trust anchors, SafeERC20 non-standard token),
/// and the master "no funds move except…" cases. The stateful/adversarial invariants live in
/// UntchVault.invariant.t.sol.
contract UntchVaultTest is Test {
    // secp256k1 group order (for malleable-signature construction).
    uint256 internal constant SECP256K1N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    UntchVault internal vault;
    MockERC20 internal token;
    MockIntentRegistry internal registry;

    address internal oracle;
    uint256 internal oraclePk;
    address internal badSigner;
    uint256 internal badSignerPk;

    address internal owner; // == address(this)
    address internal stranger = makeAddr("stranger");
    address internal payee = makeAddr("payee");
    address internal fallbackee = makeAddr("fallbackee");

    uint256 internal constant PER_TX_CAP = 100e6;
    uint256 internal constant EPOCH_BUDGET = 250e6;
    uint64 internal constant EPOCH_LEN = 1 days;
    uint256 internal constant START_TS = 1_800_000_000;

    // Local event redeclarations for vm.expectEmit.
    event Deposit(address indexed token, address indexed from, uint256 amount);
    event VaultSpend(
        address indexed recipient,
        address indexed token,
        bytes32 indexed intentHash,
        uint256 amount,
        uint256 nonce,
        bool fallbackPath
    );
    event OwnerWithdraw(address indexed token, address indexed to, uint256 amount);
    event OracleChanged(address indexed previousOracle, address indexed newOracle);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event FallbackAllowlistSet(address indexed recipient, uint256 perTxMax);

    function setUp() public {
        vm.warp(START_TS);
        owner = address(this);
        (oracle, oraclePk) = makeAddrAndKey("oracle");
        (badSigner, badSignerPk) = makeAddrAndKey("badSigner");

        token = new MockERC20();
        registry = new MockIntentRegistry();

        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vault = new UntchVault(
            owner, oracle, address(registry), PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, allow, true
        );

        token.mint(owner, 1_000_000e6);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(address(token), 1_000_000e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _sign(
        uint256 pk,
        address recipient,
        uint256 amount,
        address tok,
        bytes32 intentHash,
        uint256 nonce,
        uint256 expiry
    ) internal view returns (bytes memory) {
        bytes32 digest = vault.spendDigest(recipient, amount, tok, intentHash, nonce, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Sign + execute a canonical, usable, in-cap spend. Marks the intent usable first.
    function _spend(uint256 amount, uint256 nonce) internal returns (bytes32 intentHash) {
        intentHash = keccak256(abi.encode("intent", nonce));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, amount, address(token), intentHash, nonce, expiry);
        vault.spend(payee, amount, address(token), intentHash, sig, nonce, expiry);
    }

    function _deployVault(address reg, bool requireIntent) internal returns (UntchVault v) {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        v = new UntchVault(
            owner, oracle, reg, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, allow, requireIntent
        );
        token.mint(owner, 1_000_000e6);
        token.approve(address(v), type(uint256).max);
        v.deposit(address(token), 1_000_000e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // constructor
    // ─────────────────────────────────────────────────────────────────────────

    function test_Constructor_SetsImmutablesAndInitialState() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.oracle(), oracle);
        assertEq(address(vault.intentRegistry()), address(registry));
        assertEq(vault.perTxCap(), PER_TX_CAP);
        assertEq(vault.epochBudget(), EPOCH_BUDGET);
        assertEq(vault.epochLen(), EPOCH_LEN);
        assertEq(vault.epochGenesis(), START_TS);
        assertTrue(vault.requireAnchoredIntent());
        assertTrue(vault.tokenAllowed(address(token)));
        assertFalse(vault.paused());
        assertEq(vault.currentEpoch(), 0);
        assertEq(vault.epochSpent(), 0);
    }

    function test_RevertWhen_ConstructorZeroOwner() public {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vm.expectRevert(UntchVault.ZeroAddress.selector);
        new UntchVault(address(0), oracle, address(registry), 1, 1, 1, allow, false);
    }

    function test_RevertWhen_ConstructorZeroOracle() public {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vm.expectRevert(UntchVault.ZeroAddress.selector);
        new UntchVault(owner, address(0), address(registry), 1, 1, 1, allow, false);
    }

    function test_RevertWhen_ConstructorZeroPerTxCap() public {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vm.expectRevert(UntchVault.ZeroValue.selector);
        new UntchVault(owner, oracle, address(registry), 0, 1, 1, allow, false);
    }

    function test_RevertWhen_ConstructorZeroEpochBudget() public {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vm.expectRevert(UntchVault.ZeroValue.selector);
        new UntchVault(owner, oracle, address(registry), 1, 0, 1, allow, false);
    }

    function test_RevertWhen_ConstructorZeroEpochLen() public {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vm.expectRevert(UntchVault.ZeroValue.selector);
        new UntchVault(owner, oracle, address(registry), 1, 1, 0, allow, false);
    }

    function test_RevertWhen_ConstructorEmptyAllowlist() public {
        address[] memory allow = new address[](0);
        vm.expectRevert(UntchVault.EmptyTokenAllowlist.selector);
        new UntchVault(owner, oracle, address(registry), 1, 1, 1, allow, false);
    }

    function test_RevertWhen_ConstructorZeroTokenInAllowlist() public {
        address[] memory allow = new address[](2);
        allow[0] = address(token);
        allow[1] = address(0);
        vm.expectRevert(UntchVault.ZeroAddress.selector);
        new UntchVault(owner, oracle, address(registry), 1, 1, 1, allow, false);
    }

    function test_RevertWhen_ConstructorRequireIntentButZeroRegistry() public {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vm.expectRevert(UntchVault.IntentRegistryRequired.selector);
        new UntchVault(owner, oracle, address(0), 1, 1, 1, allow, true);
    }

    function test_Constructor_NoIntentRequired_AllowsZeroRegistry() public {
        address[] memory allow = new address[](1);
        allow[0] = address(token);
        UntchVault v = new UntchVault(
            owner, oracle, address(0), PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, allow, false
        );
        assertFalse(v.requireAnchoredIntent());
        assertEq(address(v.intentRegistry()), address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deposit
    // ─────────────────────────────────────────────────────────────────────────

    function test_Deposit_PullsAndEmits() public {
        token.mint(stranger, 500e6);
        vm.startPrank(stranger);
        token.approve(address(vault), 500e6);
        vm.expectEmit(true, true, true, true, address(vault));
        emit Deposit(address(token), stranger, 500e6);
        vault.deposit(address(token), 500e6);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 1_000_000e6 + 500e6);
    }

    function test_RevertWhen_DepositNonAllowlistedToken() public {
        MockERC20 other = new MockERC20();
        other.mint(owner, 1e6);
        other.approve(address(vault), 1e6);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.TokenNotAllowed.selector, address(other)));
        vault.deposit(address(other), 1e6);
    }

    function test_RevertWhen_DepositZeroAmount() public {
        vm.expectRevert(UntchVault.ZeroValue.selector);
        vault.deposit(address(token), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // spend — happy path
    // ─────────────────────────────────────────────────────────────────────────

    function test_Spend_HappyPath_TransfersAndAccounts() public {
        bytes32 intentHash = keccak256(abi.encode("intent", uint256(1)));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 40e6, address(token), intentHash, 1, expiry);

        vm.expectEmit(true, true, true, true, address(vault));
        emit VaultSpend(payee, address(token), intentHash, 40e6, 1, false);
        vault.spend(payee, 40e6, address(token), intentHash, sig, 1, expiry);

        assertEq(token.balanceOf(payee), 40e6);
        assertTrue(vault.nonceUsed(1));
        assertEq(vault.epochSpent(), 40e6);
        assertEq(vault.currentEpoch(), 0);
    }

    function test_Spend_AnyoneMayRelayOracleSignedSpend() public {
        bytes32 intentHash = keccak256(abi.encode("intent", uint256(9)));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 9, expiry);
        // A stranger relays — the oracle signature is the capability, not msg.sender.
        vm.prank(stranger);
        vault.spend(payee, 10e6, address(token), intentHash, sig, 9, expiry);
        assertEq(token.balanceOf(payee), 10e6);
    }

    function test_Spend_ExpiryAtExactNowIsValid() public {
        bytes32 intentHash = keccak256(abi.encode("intent", uint256(2)));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp; // now == expiry → not expired (guard is now > expiry)
        bytes memory sig = _sign(oraclePk, payee, 5e6, address(token), intentHash, 2, expiry);
        vault.spend(payee, 5e6, address(token), intentHash, sig, 2, expiry);
        assertEq(token.balanceOf(payee), 5e6);
    }

    function test_Spend_AmountAtExactPerTxCapIsValid() public {
        bytes32 intentHash = keccak256(abi.encode("intent", uint256(3)));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, PER_TX_CAP, address(token), intentHash, 3, expiry);
        vault.spend(payee, PER_TX_CAP, address(token), intentHash, sig, 3, expiry);
        assertEq(token.balanceOf(payee), PER_TX_CAP);
    }

    function test_Spend_NoIntentRequired_SkipsRegistry() public {
        UntchVault v = _deployVault(address(0), false);
        bytes32 intentHash = keccak256("whatever");
        uint256 expiry = block.timestamp + 600;
        bytes32 digest = v.spendDigest(payee, 7e6, address(token), intentHash, 1, expiry);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        v.spend(payee, 7e6, address(token), intentHash, abi.encodePacked(r, s, vv), 1, expiry);
        assertEq(token.balanceOf(payee), 7e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // spend — every §7.5 revert path (each named)
    // ─────────────────────────────────────────────────────────────────────────

    function test_RevertWhen_Spend_VaultPaused() public {
        vault.pause();
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 1, expiry);
        vm.expectRevert(UntchVault.VaultPaused.selector);
        vault.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);
    }

    function test_RevertWhen_Spend_SigExpired() public {
        vm.warp(START_TS + 1000);
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp - 1;
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 1, expiry);
        vm.expectRevert(
            abi.encodeWithSelector(UntchVault.SigExpired.selector, expiry, block.timestamp)
        );
        vault.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);
    }

    function test_RevertWhen_Spend_NonceReplay() public {
        _spend(10e6, 42);
        // Re-submit the exact same authorization — nonce now used.
        bytes32 intentHash = keccak256(abi.encode("intent", uint256(42)));
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 42, expiry);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NonceReplay.selector, uint256(42)));
        vault.spend(payee, 10e6, address(token), intentHash, sig, 42, expiry);
    }

    function test_RevertWhen_Spend_BadOracle() public {
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        // Signed by the WRONG key → recovers to badSigner, not oracle.
        bytes memory sig = _sign(badSignerPk, payee, 10e6, address(token), intentHash, 1, expiry);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.BadOracle.selector, badSigner, oracle));
        vault.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);
    }

    function test_RevertWhen_Spend_CapExceeded() public {
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        uint256 amount = PER_TX_CAP + 1;
        bytes memory sig = _sign(oraclePk, payee, amount, address(token), intentHash, 1, expiry);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.CapExceeded.selector, amount, PER_TX_CAP));
        vault.spend(payee, amount, address(token), intentHash, sig, 1, expiry);
    }

    function test_RevertWhen_Spend_BudgetExceeded() public {
        // cap 100e6, budget 250e6 → 100 + 100 + 100 = 300 > 250 on the third.
        _spend(100e6, 1);
        _spend(100e6, 2);
        bytes32 intentHash = keccak256(abi.encode("intent", uint256(3)));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 100e6, address(token), intentHash, 3, expiry);
        vm.expectRevert(
            abi.encodeWithSelector(UntchVault.BudgetExceeded.selector, uint256(300e6), EPOCH_BUDGET)
        );
        vault.spend(payee, 100e6, address(token), intentHash, sig, 3, expiry);
    }

    function test_RevertWhen_Spend_TokenNotAllowed() public {
        MockERC20 other = new MockERC20();
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(other), intentHash, 1, expiry);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.TokenNotAllowed.selector, address(other)));
        vault.spend(payee, 10e6, address(other), intentHash, sig, 1, expiry);
    }

    function test_RevertWhen_Spend_IntentNotApproved() public {
        bytes32 intentHash = keccak256("i");
        // registry.usable[intentHash] left false.
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 1, expiry);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.IntentNotApproved.selector, intentHash));
        vault.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // judgment call 5 — cross-contract check FAILS CLOSED (no try/catch, ever)
    // ─────────────────────────────────────────────────────────────────────────

    function _assertFailClosed(UntchVault v) internal {
        bytes32 intentHash = keccak256("i");
        uint256 expiry = block.timestamp + 600;
        bytes32 digest = v.spendDigest(payee, 10e6, address(token), intentHash, 1, expiry);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        bytes memory sig = abi.encodePacked(r, s, vv);

        uint256 balBefore = token.balanceOf(payee);
        vm.expectRevert(); // ANY revert — the point is it does NOT silently proceed.
        v.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);

        // Confirm nothing moved and no state was consumed.
        assertEq(token.balanceOf(payee), balBefore, "no funds moved on a failed intent check");
        assertFalse(v.nonceUsed(1), "nonce not consumed on a failed intent check");
        assertEq(v.epochSpent(), 0, "epoch not touched on a failed intent check");
    }

    function test_CrossContract_RevertingRegistry_FailsClosed() public {
        _assertFailClosed(_deployVault(address(new RevertingRegistry()), true));
    }

    function test_CrossContract_EmptyReturnRegistry_FailsClosed() public {
        _assertFailClosed(_deployVault(address(new EmptyReturnRegistry()), true));
    }

    function test_CrossContract_GarbageReturnRegistry_FailsClosed() public {
        _assertFailClosed(_deployVault(address(new GarbageReturnRegistry()), true));
    }

    function test_CrossContract_NoCodeRegistry_FailsClosed() public {
        // A non-zero EOA address as the registry: a high-level call to no-code reverts on return decode.
        _assertFailClosed(_deployVault(makeAddr("eoaRegistry"), true));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // signature malleability — the malleable (high-s) form is rejected
    // ─────────────────────────────────────────────────────────────────────────

    function test_Spend_MalleableSignatureRejected() public {
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes32 digest = vault.spendDigest(payee, 10e6, address(token), intentHash, 1, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);

        // The canonical low-s sig works; its malleable twin (n-s, flipped v) must be rejected.
        bytes32 sMal = bytes32(SECP256K1N - uint256(s));
        uint8 vMal = v == 27 ? 28 : 27;
        bytes memory malSig = abi.encodePacked(r, sMal, vMal);

        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, sMal));
        vault.spend(payee, 10e6, address(token), intentHash, malSig, 1, expiry);
        assertFalse(vault.nonceUsed(1), "malleable sig must not consume the nonce");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // chainId dynamism — domain separator tracks block.chainid (replay protection)
    // ─────────────────────────────────────────────────────────────────────────

    function test_DomainSeparator_RecomputesOnChainIdChange() public {
        bytes32 before = vault.domainSeparator();
        vm.chainId(block.chainid + 1);
        bytes32 afterFork = vault.domainSeparator();
        assertTrue(before != afterFork, "domain separator must change with chainId");
    }

    function test_Spend_CrossChainReplayRejected() public {
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 1, expiry);

        // Same signature, different chain → the domain's chainId changes → digest differs → the sig
        // recovers to a DIFFERENT address → BadOracle. Compute that exact address so we assert the
        // specific BadOracle branch (not a bare revert): the new-chain digest recovered against the sig.
        vm.chainId(block.chainid + 12_345);
        bytes32 forkedDigest = vault.spendDigest(payee, 10e6, address(token), intentHash, 1, expiry);
        address recovered = ECDSA.recover(forkedDigest, sig);
        assertTrue(recovered != oracle, "cross-chain digest must recover to a non-oracle address");
        vm.expectRevert(abi.encodeWithSelector(UntchVault.BadOracle.selector, recovered, oracle));
        vault.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SafeERC20 — a non-bool-returning (USDT-style) token is moved correctly
    // ─────────────────────────────────────────────────────────────────────────

    function test_Spend_NonStandardTokenViaSafeERC20() public {
        MockERC20NoReturn nrt = new MockERC20NoReturn();
        address[] memory allow = new address[](1);
        allow[0] = address(nrt);
        UntchVault v = new UntchVault(
            owner, oracle, address(registry), PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, allow, false
        );
        nrt.mint(owner, 1000e6);
        nrt.approve(address(v), type(uint256).max);
        v.deposit(address(nrt), 1000e6); // safeTransferFrom on a no-return token

        bytes32 intentHash = keccak256("i");
        uint256 expiry = block.timestamp + 600;
        bytes32 digest = v.spendDigest(payee, 25e6, address(nrt), intentHash, 1, expiry);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        v.spend(payee, 25e6, address(nrt), intentHash, abi.encodePacked(r, s, vv), 1, expiry);
        assertEq(nrt.balanceOf(payee), 25e6, "safeTransfer moved a no-return token");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // reentrancy — CEI + guard block a reentrant token
    // ─────────────────────────────────────────────────────────────────────────

    function test_Spend_ReentrantTokenCannotDoubleSpend() public {
        ReentrantToken rt = new ReentrantToken();
        address[] memory allow = new address[](1);
        allow[0] = address(rt);
        UntchVault v = new UntchVault(
            owner, oracle, address(registry), PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, allow, false
        );
        rt.setVault(v);
        rt.mint(owner, 1000e6);
        rt.approve(address(v), type(uint256).max);
        v.deposit(address(rt), 1000e6);

        // Arm the token to reenter spend() with a second (different-nonce) authorization on transfer.
        bytes32 intentHash2 = keccak256("i2");
        uint256 expiry = block.timestamp + 600;
        bytes32 digest2 = v.spendDigest(payee, 5e6, address(rt), intentHash2, 2, expiry);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(oraclePk, digest2);
        bytes memory payload = abi.encodeCall(
            UntchVault.spend,
            (payee, 5e6, address(rt), intentHash2, abi.encodePacked(r2, s2, v2), 2, expiry)
        );
        rt.arm(payload);

        // Outer spend #1 succeeds; the reentrant #2 fires inside transfer and is blocked by the guard.
        bytes32 intentHash1 = keccak256("i1");
        bytes32 digest1 = v.spendDigest(payee, 5e6, address(rt), intentHash1, 1, expiry);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(oraclePk, digest1);
        v.spend(payee, 5e6, address(rt), intentHash1, abi.encodePacked(r1, s1, v1), 1, expiry);

        assertFalse(rt.reentered(), "reentrant spend must be blocked");
        assertEq(rt.balanceOf(payee), 5e6, "exactly one transfer, no double spend");
        assertFalse(v.nonceUsed(2), "reentrant nonce never consumed");
        assertEq(v.epochSpent(), 5e6, "epoch accounted exactly once");
    }

    /// @notice Guard-INDEPENDENT proof of checks-effects-interactions ordering (judgment call 6). The
    /// probe token reads the vault's `epochSpent`/`nonceUsed` DURING the transfer (the interaction);
    /// view getters aren't blocked by `nonReentrant`, so this observes the real ordering. Correct CEI ⇒
    /// effects already committed at transfer time. This test would FAIL (observe 0 / false) if the
    /// effects were moved after `safeTransfer`, even though the reentrancy guard would still be present —
    /// closing the gap where the guard alone could mask a CEI regression.
    function test_Spend_EffectsCommittedBeforeTransfer_CEI() public {
        CEIProbeToken pt = new CEIProbeToken();
        address[] memory allow = new address[](1);
        allow[0] = address(pt);
        UntchVault v = new UntchVault(
            owner, oracle, address(registry), PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, allow, false
        );
        pt.setVault(v);
        pt.watch(7);
        pt.mint(owner, 1000e6);
        pt.approve(address(v), type(uint256).max);
        v.deposit(address(pt), 1000e6);

        bytes32 intentHash = keccak256("cei");
        uint256 expiry = block.timestamp + 600;
        bytes32 digest = v.spendDigest(payee, 33e6, address(pt), intentHash, 7, expiry);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        v.spend(payee, 33e6, address(pt), intentHash, abi.encodePacked(r, s, vv), 7, expiry);

        assertTrue(pt.observed(), "probe ran during the transfer");
        assertEq(pt.observedEpochSpent(), 33e6, "epochSpent committed BEFORE the transfer (CEI)");
        assertTrue(pt.observedNonceUsed(), "nonce marked used BEFORE the transfer (CEI)");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // epoch accounting + rollover boundary
    // ─────────────────────────────────────────────────────────────────────────

    function test_Epoch_ResetsExactlyOnRollover() public {
        _spend(100e6, 1);
        assertEq(vault.epochSpent(), 100e6);
        assertEq(vault.currentEpoch(), 0);

        // One second before the boundary: still epoch 0, still accumulates.
        vm.warp(START_TS + EPOCH_LEN - 1);
        _spend(100e6, 2);
        assertEq(vault.epochSpent(), 200e6, "still epoch 0 one second before boundary");
        assertEq(vault.currentEpoch(), 0);

        // Exactly at the boundary: rolls to epoch 1, epochSpent resets then adds this spend.
        vm.warp(START_TS + EPOCH_LEN);
        _spend(100e6, 3);
        assertEq(vault.currentEpoch(), 1, "epoch rolled at exact boundary");
        assertEq(vault.epochSpent(), 100e6, "epochSpent reset on rollover");
    }

    function test_EpochOf_MatchesFormula() public view {
        assertEq(vault.epochOf(START_TS), 0);
        assertEq(vault.epochOf(START_TS + EPOCH_LEN - 1), 0);
        assertEq(vault.epochOf(START_TS + EPOCH_LEN), 1);
        assertEq(vault.epochOf(START_TS + 3 * EPOCH_LEN + 5), 3);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // spendFallback — full battery
    // ─────────────────────────────────────────────────────────────────────────

    function test_Fallback_HappyPath() public {
        vault.setFallbackAllowlist(fallbackee, 50e6);
        vm.expectEmit(true, true, true, true, address(vault));
        emit VaultSpend(fallbackee, address(token), bytes32(0), 30e6, 0, true);
        vault.spendFallback(fallbackee, 30e6, address(token));
        assertEq(token.balanceOf(fallbackee), 30e6);
        assertEq(vault.epochSpent(), 30e6);
    }

    function test_RevertWhen_Fallback_RecipientNotAllowed() public {
        vm.expectRevert(
            abi.encodeWithSelector(UntchVault.FallbackRecipientNotAllowed.selector, fallbackee)
        );
        vault.spendFallback(fallbackee, 1e6, address(token));
    }

    function test_RevertWhen_Fallback_CapExceeded() public {
        vault.setFallbackAllowlist(fallbackee, 20e6);
        vm.expectRevert(
            abi.encodeWithSelector(UntchVault.CapExceeded.selector, uint256(21e6), 20e6)
        );
        vault.spendFallback(fallbackee, 21e6, address(token));
    }

    function test_RevertWhen_Fallback_ZeroAmount() public {
        vault.setFallbackAllowlist(fallbackee, 20e6);
        vm.expectRevert(UntchVault.ZeroValue.selector);
        vault.spendFallback(fallbackee, 0, address(token));
    }

    function test_RevertWhen_Fallback_TokenNotAllowed() public {
        vault.setFallbackAllowlist(fallbackee, 50e6);
        MockERC20 other = new MockERC20();
        vm.expectRevert(abi.encodeWithSelector(UntchVault.TokenNotAllowed.selector, address(other)));
        vault.spendFallback(fallbackee, 10e6, address(other));
    }

    function test_RevertWhen_Fallback_Paused() public {
        vault.setFallbackAllowlist(fallbackee, 50e6);
        vault.pause();
        vm.expectRevert(UntchVault.VaultPaused.selector);
        vault.spendFallback(fallbackee, 10e6, address(token));
    }

    function test_RevertWhen_Fallback_BudgetExceeded() public {
        vault.setFallbackAllowlist(fallbackee, PER_TX_CAP);
        vault.setFallbackAllowlist(fallbackee, PER_TX_CAP); // idempotent set
        _spend(100e6, 1);
        _spend(100e6, 2); // epochSpent = 200
        vm.expectRevert(
            abi.encodeWithSelector(UntchVault.BudgetExceeded.selector, uint256(300e6), EPOCH_BUDGET)
        );
        vault.spendFallback(fallbackee, 100e6, address(token));
    }

    function test_RevertWhen_Fallback_NonOwner() public {
        vault.setFallbackAllowlist(fallbackee, 50e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, stranger));
        vault.spendFallback(fallbackee, 10e6, address(token));
    }

    function test_Fallback_SharesEpochBudgetWithOraclePath() public {
        vault.setFallbackAllowlist(fallbackee, PER_TX_CAP);
        _spend(80e6, 1); // oracle path
        vault.spendFallback(fallbackee, 40e6, address(token)); // fallback path
        assertEq(vault.epochSpent(), 120e6, "both paths share one epoch total");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ownerWithdraw — unconditional (never paused, never oracle)
    // ─────────────────────────────────────────────────────────────────────────

    function test_OwnerWithdraw_Transfers() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit OwnerWithdraw(address(token), owner, 500e6);
        vault.ownerWithdraw(address(token), owner, 500e6);
        assertEq(token.balanceOf(address(vault)), 1_000_000e6 - 500e6);
    }

    function test_OwnerWithdraw_WorksWhilePaused() public {
        vault.pause();
        vault.ownerWithdraw(address(token), owner, 123e6); // must NOT be blocked by pause
        assertEq(token.balanceOf(owner), 123e6);
    }

    function test_OwnerWithdraw_DoesNotTouchEpochAccounting() public {
        _spend(50e6, 1);
        uint256 spentBefore = vault.epochSpent();
        vault.ownerWithdraw(address(token), owner, 100e6);
        assertEq(
            vault.epochSpent(), spentBefore, "withdraw is the sovereign exit, not a policy spend"
        );
    }

    function test_OwnerWithdraw_CanRescueNonAllowlistedToken() public {
        MockERC20 other = new MockERC20();
        other.mint(address(vault), 77e6); // accidentally-sent token
        vault.ownerWithdraw(address(other), owner, 77e6);
        assertEq(other.balanceOf(owner), 77e6);
    }

    function test_RevertWhen_OwnerWithdraw_NonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, stranger));
        vault.ownerWithdraw(address(token), stranger, 1e6);
    }

    function test_RevertWhen_OwnerWithdraw_ZeroTo() public {
        vm.expectRevert(UntchVault.ZeroAddress.selector);
        vault.ownerWithdraw(address(token), address(0), 1e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setOracle / pause / unpause / setFallbackAllowlist
    // ─────────────────────────────────────────────────────────────────────────

    function test_SetOracle_RotatesAndEmits() public {
        (address newOracle, uint256 newPk) = makeAddrAndKey("newOracle");
        vm.expectEmit(true, true, true, true, address(vault));
        emit OracleChanged(oracle, newOracle);
        vault.setOracle(newOracle);
        assertEq(vault.oracle(), newOracle);

        // New oracle's sig now works; old oracle's sig no longer does.
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory newSig = _sign(newPk, payee, 10e6, address(token), intentHash, 1, expiry);
        vault.spend(payee, 10e6, address(token), intentHash, newSig, 1, expiry);
        assertEq(token.balanceOf(payee), 10e6);

        bytes memory oldSig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 2, expiry);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.BadOracle.selector, oracle, newOracle));
        vault.spend(payee, 10e6, address(token), intentHash, oldSig, 2, expiry);
    }

    function test_RevertWhen_SetOracle_NonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, stranger));
        vault.setOracle(stranger);
    }

    function test_RevertWhen_SetOracle_Zero() public {
        vm.expectRevert(UntchVault.ZeroAddress.selector);
        vault.setOracle(address(0));
    }

    function test_PauseUnpause_TogglesAndEmits() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit Paused(owner);
        vault.pause();
        assertTrue(vault.paused());

        vm.expectEmit(true, true, true, true, address(vault));
        emit Unpaused(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_RevertWhen_Pause_NonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, stranger));
        vault.pause();
    }

    function test_RevertWhen_Unpause_NonOwner() public {
        vault.pause();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, stranger));
        vault.unpause();
    }

    function test_SetFallbackAllowlist_SetAndClear() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit FallbackAllowlistSet(fallbackee, 50e6);
        vault.setFallbackAllowlist(fallbackee, 50e6);
        assertEq(vault.fallbackPerTxMax(fallbackee), 50e6);

        vault.setFallbackAllowlist(fallbackee, 0); // clear
        assertEq(vault.fallbackPerTxMax(fallbackee), 0);
    }

    function test_RevertWhen_SetFallbackAllowlist_NonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, stranger));
        vault.setFallbackAllowlist(fallbackee, 1e6);
    }

    function test_RevertWhen_SetFallbackAllowlist_ZeroRecipient() public {
        vm.expectRevert(UntchVault.ZeroAddress.selector);
        vault.setFallbackAllowlist(address(0), 1e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // transferOwnership / acceptOwnership (two-step — judgment call 4)
    // ─────────────────────────────────────────────────────────────────────────

    function test_TransferOwnership_TwoStepRotation() public {
        address newOwner = makeAddr("newOwner");

        vm.expectEmit(true, true, true, true, address(vault));
        emit OwnershipTransferStarted(owner, newOwner);
        vault.transferOwnership(newOwner);
        assertEq(vault.pendingOwner(), newOwner, "pending set");
        assertEq(vault.owner(), owner, "owner unchanged until accept");

        // Old owner still has privileges before acceptance.
        vault.pause();
        vault.unpause();

        vm.expectEmit(true, true, true, true, address(vault));
        emit OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner, "owner rotated");
        assertEq(vault.pendingOwner(), address(0), "pending cleared");

        // New owner has privileges; old owner does not.
        vm.prank(newOwner);
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, owner));
        vault.pause();
    }

    function test_RevertWhen_TransferOwnership_NonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotOwner.selector, stranger));
        vault.transferOwnership(stranger);
    }

    function test_RevertWhen_AcceptOwnership_NotPendingOwner() public {
        vault.transferOwnership(makeAddr("newOwner"));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotPendingOwner.selector, stranger));
        vault.acceptOwnership();
    }

    function test_TransferOwnership_OwnerCanRetargetPending() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        vault.transferOwnership(a);
        vault.transferOwnership(b); // overwrite
        assertEq(vault.pendingOwner(), b);
        // The stale pending (a) can no longer accept.
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotPendingOwner.selector, a));
        vault.acceptOwnership();
        vm.prank(b);
        vault.acceptOwnership();
        assertEq(vault.owner(), b);
    }

    function test_TransferOwnership_ZeroCancelsPending() public {
        address a = makeAddr("a");
        vault.transferOwnership(a);
        vault.transferOwnership(address(0)); // cancel
        assertEq(vault.pendingOwner(), address(0));
        // Nobody can accept a cleared transfer (the prior target included).
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.NotPendingOwner.selector, a));
        vault.acceptOwnership();
    }

    function test_TransferOwnership_DoesNotAffectFundsOrOracle() public {
        // Rotating the owner does not move funds and does not change the oracle capability.
        _spend(20e6, 1);
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.oracle(), oracle, "oracle unchanged by ownership rotation");
        // A new oracle-signed spend still works under the new owner (owner isn't in the spend path).
        _spend(20e6, 2);
        assertEq(token.balanceOf(payee), 40e6);
        // The new owner holds the unconditional withdraw.
        vm.prank(newOwner);
        vault.ownerWithdraw(address(token), newOwner, 10e6);
        assertEq(token.balanceOf(newOwner), 10e6);
    }

    function test_PendingOwner_DefaultsZero() public view {
        assertEq(vault.pendingOwner(), address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Any valid oracle-signed spend within caps, usable intent, unexpired, unused nonce
    /// transfers exactly `amount` and consumes the nonce.
    function testFuzz_Spend_ValidWithinBounds(uint256 amount, uint256 nonce, uint64 dt) public {
        amount = bound(amount, 1, PER_TX_CAP);
        dt = uint64(bound(dt, 0, 3600));
        bytes32 intentHash = keccak256(abi.encode("intent", nonce));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + dt;
        bytes memory sig = _sign(oraclePk, payee, amount, address(token), intentHash, nonce, expiry);
        vault.spend(payee, amount, address(token), intentHash, sig, nonce, expiry);
        assertEq(token.balanceOf(payee), amount);
        assertTrue(vault.nonceUsed(nonce));
        assertEq(vault.epochSpent(), amount);
    }

    /// @notice Any signature that does NOT recover to the oracle is rejected (BadOracle), for random
    /// wrong keys — never a silent success.
    function testFuzz_Spend_WrongSignerRejected(uint256 wrongPk) public {
        wrongPk = bound(wrongPk, 1, SECP256K1N - 1);
        vm.assume(vm.addr(wrongPk) != oracle);
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(wrongPk, payee, 10e6, address(token), intentHash, 1, expiry);
        vm.expectRevert(
            abi.encodeWithSelector(UntchVault.BadOracle.selector, vm.addr(wrongPk), oracle)
        );
        vault.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);
    }

    /// @notice The per-tx cap boundary is exact: `amount == cap` passes, `amount == cap + 1` reverts.
    function testFuzz_Spend_CapBoundary(uint256 amount) public {
        amount = bound(amount, PER_TX_CAP + 1, type(uint128).max);
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _sign(oraclePk, payee, amount, address(token), intentHash, 1, expiry);
        vm.expectRevert(abi.encodeWithSelector(UntchVault.CapExceeded.selector, amount, PER_TX_CAP));
        vault.spend(payee, amount, address(token), intentHash, sig, 1, expiry);
    }

    /// @notice Fuzz timestamps AT and around the epoch boundary: `epochOf` and the reset are exact.
    function testFuzz_Epoch_BoundaryExact(uint64 offset) public {
        // Sweep the window straddling the first boundary.
        offset = uint64(bound(offset, 0, 2 * EPOCH_LEN));
        uint256 ts = START_TS + offset;
        vm.warp(ts);
        uint256 expectedEpoch = uint256(offset) / EPOCH_LEN;
        assertEq(vault.epochOf(ts), expectedEpoch);

        _spend(1e6, uint256(offset) + 1);
        assertEq(vault.currentEpoch(), expectedEpoch, "spend rolls to the correct epoch");
        assertEq(vault.epochSpent(), 1e6, "fresh epoch starts from this spend");
    }

    /// @notice Expiry boundary is exact: `now <= expiry` passes, `now > expiry` reverts.
    function testFuzz_Spend_ExpiryBoundary(uint64 skew) public {
        skew = uint64(bound(skew, 1, 100_000));
        vm.warp(START_TS + skew);
        bytes32 intentHash = keccak256("i");
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp - 1; // strictly past
        bytes memory sig = _sign(oraclePk, payee, 10e6, address(token), intentHash, 1, expiry);
        vm.expectRevert(
            abi.encodeWithSelector(UntchVault.SigExpired.selector, expiry, block.timestamp)
        );
        vault.spend(payee, 10e6, address(token), intentHash, sig, 1, expiry);
    }
}
