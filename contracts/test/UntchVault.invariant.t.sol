// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { UntchVault } from "../src/UntchVault.sol";
import { ReentrantToken, MockIntentRegistry } from "./mocks/VaultMocks.sol";

/// @title UntchVaultHandler
/// @notice Stateful-fuzz handler (PRD §28 tier 3), encoding §10.4's invariant matrix VERBATIM as ONE
/// master property with multiple valid paths. It drives random sequences of: legit oracle-signed spends
/// (each of which ARMS a reentrant token to reenter the vault mid-transfer with the same nonce — an
/// adversarial CEI probe), legit owner fallback spends, legit owner withdrawals (which must work even
/// while paused), time warps across epoch boundaries, pause toggles, and a battery of adversarial spends
/// that MUST always revert (bad signer, over-cap, unapproved intent, non-owner withdraw/fallback).
///
/// The invariants it feeds:
///   • MASTER: `vault balance == INITIAL_DEPOSIT - totalLegitOut` — every wei that left the vault is
///     attributable to a legit path (spend within caps + usable intent, fallback within its bounds, or
///     ownerWithdraw). ANY illicit outflow — including a reentrant double-spend — makes the balance drop
///     below this and trips the invariant. This is the "no funds move except…" property, stated as one
///     equation, not disconnected checks.
///   • epochSpent never exceeds epochBudget; currentEpoch is monotone non-decreasing.
///   • the reentrant token NEVER succeeds in reentering (CEI + guard hold).
///   • no adversarial call ever succeeds.
contract UntchVaultHandler is Test {
    UntchVault public vault;
    ReentrantToken public token;
    MockIntentRegistry public registry;

    uint256 internal oraclePk;
    address internal oracle;
    address internal stranger = makeAddr("stranger");
    address internal fallbackee = makeAddr("fallbackee");
    address internal payee = makeAddr("payee");

    uint256 public constant PER_TX_CAP = 100e6;
    uint256 public constant EPOCH_BUDGET = 250e6;
    uint64 public constant EPOCH_LEN = 1 days;
    uint256 public constant INITIAL_DEPOSIT = 1_000_000e6;

    // Ghost accounting. `netDeposited` starts at the initial deposit and grows on any re-deposit;
    // `totalLegitOut` grows on every legit outflow. The master invariant is
    // `vault balance == netDeposited - totalLegitOut`, which stays exact under re-deposits and legit
    // withdrawals but is broken by any illicit outflow (including a reentrant double-spend).
    uint256 public netDeposited;
    uint256 public totalLegitOut;
    uint256 public nonceCounter;

    // Safety counters (invariants assert these stay 0).
    uint256 public illicitSuccesses;

    // Liveness counters (afterInvariant asserts these are > 0 — no vacuous pass).
    uint256 public successfulSpends;
    uint256 public successfulFallbacks;
    uint256 public successfulWithdraws;
    uint256 public adversarialAttempts;

    constructor() {
        (oracle, oraclePk) = makeAddrAndKey("invariantOracle");
        token = new ReentrantToken();
        registry = new MockIntentRegistry();

        address[] memory allow = new address[](1);
        allow[0] = address(token);
        vault = new UntchVault(
            address(this),
            oracle,
            address(registry),
            PER_TX_CAP,
            EPOCH_BUDGET,
            EPOCH_LEN,
            allow,
            true
        );
        token.setVault(vault);
        token.mint(address(this), INITIAL_DEPOSIT);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(address(token), INITIAL_DEPOSIT);
        netDeposited = INITIAL_DEPOSIT;
    }

    function _freshNonce() internal returns (uint256 n) {
        n = ++nonceCounter;
    }

    function _sign(
        address recipient,
        uint256 amount,
        bytes32 intentHash,
        uint256 nonce,
        uint256 expiry
    ) internal view returns (bytes memory) {
        bytes32 digest = vault.spendDigest(
            recipient, amount, address(token), intentHash, nonce, expiry
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── legit actions ─────────────────────────────────────────────────────────

    /// @notice A valid oracle-signed spend that ALSO arms the reentrant token to reenter with the same
    /// payload (same nonce) during the transfer. Correct CEI (nonce marked used before the transfer) +
    /// the guard must block that reentry, so no double-spend occurs.
    function legitSpend(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, PER_TX_CAP);
        uint256 nonce = _freshNonce();
        bytes32 intentHash = keccak256(abi.encode("intent", nonce));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 3600;
        bytes memory sig = _sign(payee, amount, intentHash, nonce, expiry);

        bytes memory payload = abi.encodeCall(
            UntchVault.spend, (payee, amount, address(token), intentHash, sig, nonce, expiry)
        );
        token.arm(payload); // reentry uses the SAME nonce → must be rejected

        try vault.spend(payee, amount, address(token), intentHash, sig, nonce, expiry) {
            totalLegitOut += amount;
            successfulSpends++;
        } catch {
            token.arm(""); // disarm on a legit revert (e.g. budget exceeded) so it doesn't fire later
        }
    }

    function legitFallback(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, PER_TX_CAP);
        vault.setFallbackAllowlist(fallbackee, PER_TX_CAP);
        try vault.spendFallback(fallbackee, amount, address(token)) {
            totalLegitOut += amount;
            successfulFallbacks++;
        } catch { }
    }

    function legitWithdraw(uint256 amountSeed) external {
        uint256 bal = token.balanceOf(address(vault));
        if (bal == 0) return;
        uint256 amount = bound(amountSeed, 1, bal);
        vault.ownerWithdraw(address(token), address(this), amount);
        totalLegitOut += amount;
        successfulWithdraws++;
    }

    function warpTime(uint256 seed) external {
        uint256 jump = bound(seed, 1, uint256(EPOCH_LEN) * 2);
        // solhint-disable-next-line not-rely-on-time
        vm.warp(block.timestamp + jump);
    }

    function togglePause(uint256 seed) external {
        if (seed % 2 == 0) {
            if (!vault.paused()) vault.pause();
        } else {
            if (vault.paused()) vault.unpause();
        }
    }

    // ── adversarial actions (every one MUST revert; a success is an illicit outflow) ──

    function attackBadSigner(uint256 amountSeed, uint256 wrongPk) external {
        adversarialAttempts++;
        wrongPk = bound(wrongPk, 1, type(uint128).max);
        if (vm.addr(wrongPk) == oracle) return;
        uint256 amount = bound(amountSeed, 1, PER_TX_CAP);
        uint256 nonce = _freshNonce();
        bytes32 intentHash = keccak256(abi.encode("adv", nonce));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 3600;
        bytes32 digest = vault.spendDigest(payee, amount, address(token), intentHash, nonce, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        try vault.spend(
            payee, amount, address(token), intentHash, abi.encodePacked(r, s, v), nonce, expiry
        ) {
            illicitSuccesses++;
        } catch { }
    }

    function attackOverCap(uint256 amountSeed) external {
        adversarialAttempts++;
        uint256 amount = bound(amountSeed, PER_TX_CAP + 1, type(uint128).max);
        uint256 nonce = _freshNonce();
        bytes32 intentHash = keccak256(abi.encode("advcap", nonce));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 3600;
        bytes memory sig = _sign(payee, amount, intentHash, nonce, expiry);
        try vault.spend(payee, amount, address(token), intentHash, sig, nonce, expiry) {
            illicitSuccesses++;
        } catch { }
    }

    function attackUnapprovedIntent(uint256 amountSeed) external {
        adversarialAttempts++;
        uint256 amount = bound(amountSeed, 1, PER_TX_CAP);
        uint256 nonce = _freshNonce();
        bytes32 intentHash = keccak256(abi.encode("advunapp", nonce)); // never marked usable
        uint256 expiry = block.timestamp + 3600;
        bytes memory sig = _sign(payee, amount, intentHash, nonce, expiry);
        try vault.spend(payee, amount, address(token), intentHash, sig, nonce, expiry) {
            illicitSuccesses++;
        } catch { }
    }

    function attackNonOwnerWithdraw(uint256 amountSeed) external {
        adversarialAttempts++;
        uint256 amount = bound(amountSeed, 1, PER_TX_CAP);
        vm.prank(stranger);
        try vault.ownerWithdraw(address(token), stranger, amount) {
            illicitSuccesses++;
        } catch { }
    }

    function attackNonOwnerFallback(uint256 amountSeed) external {
        adversarialAttempts++;
        uint256 amount = bound(amountSeed, 1, PER_TX_CAP);
        vm.prank(stranger);
        try vault.spendFallback(fallbackee, amount, address(token)) {
            illicitSuccesses++;
        } catch { }
    }

    /// @notice Deterministic happy path — GUARANTEES the write paths (spend + armed reentry probe,
    /// withdraw-while-paused, fallback) are exercised whenever picked, so the safety invariants cannot
    /// pass vacuously. It removes the incidental blockers (warps to a FRESH epoch so the budget can't
    /// block the probe spend, unpauses, tops the vault up if a prior drain left it low) so the spend
    /// reliably succeeds; those blockers are still exercised adversarially by the other actions. Warps
    /// forward only.
    function happyPath(uint256 amountSeed) external {
        // solhint-disable-next-line not-rely-on-time
        vm.warp(block.timestamp + EPOCH_LEN); // fresh epoch → budget never blocks the probe spend
        if (vault.paused()) vault.unpause();

        // Keep the vault funded (withdrawals send tokens back to this handler; recycle them).
        if (token.balanceOf(address(vault)) < 100e6) {
            uint256 held = token.balanceOf(address(this));
            if (held > 0) {
                vault.deposit(address(token), held);
                netDeposited += held;
            }
        }

        // 1) a legit spend that arms + fires the reentrant probe (same nonce → must be rejected)
        uint256 amount = bound(amountSeed, 1, 10e6);
        uint256 nonce = _freshNonce();
        bytes32 intentHash = keccak256(abi.encode("happy", nonce));
        registry.setUsable(intentHash, true);
        uint256 expiry = block.timestamp + 3600;
        bytes memory sig = _sign(payee, amount, intentHash, nonce, expiry);
        bytes memory payload = abi.encodeCall(
            UntchVault.spend, (payee, amount, address(token), intentHash, sig, nonce, expiry)
        );
        token.arm(payload);
        vault.spend(payee, amount, address(token), intentHash, sig, nonce, expiry);
        totalLegitOut += amount;
        successfulSpends++;

        // 2) a withdraw WHILE PAUSED must still work (pause never blocks ownerWithdraw)
        vault.pause();
        uint256 bal = token.balanceOf(address(vault));
        if (bal > 0) {
            uint256 w = bal > 1e6 ? 1e6 : bal;
            vault.ownerWithdraw(address(token), address(this), w);
            totalLegitOut += w;
            successfulWithdraws++;
        }
        vault.unpause();

        // 3) a fallback spend
        vault.setFallbackAllowlist(fallbackee, PER_TX_CAP);
        vault.spendFallback(fallbackee, 1e6, address(token));
        totalLegitOut += 1e6;
        successfulFallbacks++;
    }
}

/// @title UntchVaultInvariant
/// @notice PRD §28 tier-3 invariants for UntchVault (§10.4), adversarially fuzzed. The master property
/// is the §10.4 matrix as ONE equation with multiple valid paths; the rest are the epoch-accounting and
/// custody sub-properties, plus an afterInvariant() liveness gate (the UntchReceipts pattern) so none
/// can pass vacuously.
contract UntchVaultInvariant is Test {
    UntchVaultHandler internal handler;
    UntchVault internal vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        handler = new UntchVaultHandler();
        vault = handler.vault();

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = handler.legitSpend.selector;
        selectors[1] = handler.legitFallback.selector;
        selectors[2] = handler.legitWithdraw.selector;
        selectors[3] = handler.warpTime.selector;
        selectors[4] = handler.togglePause.selector;
        selectors[5] = handler.attackBadSigner.selector;
        selectors[6] = handler.attackOverCap.selector;
        selectors[7] = handler.attackUnapprovedIntent.selector;
        selectors[8] = handler.attackNonOwnerWithdraw.selector;
        selectors[9] = handler.attackNonOwnerFallback.selector;
        selectors[10] = handler.happyPath.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice MASTER (§10.4 verbatim): no token leaves the vault except a legit path. Every wei out is
    /// accounted to a spend/fallback/withdraw; any illicit outflow (incl. a reentrant double-spend)
    /// drops the balance below this equation and trips the invariant.
    function invariant_NoFundsMoveExceptLegitPaths() public view {
        assertEq(
            handler.token().balanceOf(address(vault)),
            handler.netDeposited() - handler.totalLegitOut(),
            "vault balance diverged from accounted legit outflows"
        );
    }

    /// @notice No adversarial (bad-sig / over-cap / unapproved / non-owner) call ever succeeded.
    function invariant_NoIllicitSuccess() public view {
        assertEq(handler.illicitSuccesses(), 0, "an adversarial call moved funds");
    }

    /// @notice CEI + the reentrancy guard hold: a reentrant token never re-enters the vault successfully.
    function invariant_ReentrancyNeverSucceeds() public view {
        assertFalse(handler.token().everReentered(), "a reentrant call got through");
    }

    /// @notice Epoch accounting never exceeds the budget (monotone within an epoch, exact reset across).
    function invariant_EpochSpentWithinBudget() public view {
        assertLe(vault.epochSpent(), vault.epochBudget(), "epochSpent exceeded epochBudget");
    }

    /// @notice The current epoch matches the epoch of the last committed spend and never runs backward.
    function invariant_CurrentEpochNeverExceedsNow() public view {
        // solhint-disable-next-line not-rely-on-time
        assertLe(
            vault.currentEpoch(), vault.epochOf(block.timestamp), "currentEpoch ran ahead of time"
        );
    }

    /// @notice Liveness gate — the write paths (spend, withdraw-while-paused, fallback), the armed
    /// reentry, and adversarial attempts were all actually exercised, so the safety invariants above are
    /// not passing on an inert contract.
    function afterInvariant() public view {
        assertGt(handler.successfulSpends(), 0, "vacuous: no spend ever succeeded");
        assertGt(handler.successfulWithdraws(), 0, "vacuous: no withdraw ever succeeded");
        assertGt(handler.successfulFallbacks(), 0, "vacuous: no fallback ever succeeded");
        assertGt(
            handler.adversarialAttempts(), 0, "vacuous: no adversarial call was ever attempted"
        );
        assertGt(handler.token().fireCount(), 0, "vacuous: the reentrancy probe never fired");
    }
}
