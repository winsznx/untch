// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// These three paths resolve through the foundry remapping in remappings.txt
// (@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/) — proven by `forge build`. solhint
// does not read foundry remappings, so its import-path-check would false-positive; dispositioned here.
/* solhint-disable import-path-check */
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/* solhint-enable import-path-check */

/// @title ISpendIntentStatus
/// @author Untch
/// @notice The subset of SpendIntentRegistry (§10.2) UntchVault reads: whether an anchored intent may
/// authorize a spend right now (`status == APPROVED && block.timestamp <= deadline`). Declared as a
/// narrow typed interface so the cross-contract check is a normal high-level call whose failure — a
/// revert, unexpected/short return data, or a no-code address — propagates as a full revert of the
/// spend (fail closed, §16 I2). It is deliberately NOT wrapped in try/catch anywhere (judgment call 5).
interface ISpendIntentStatus {
    /// @notice Whether the anchored intent may authorize a spend right now (APPROVED and not expired).
    /// @param intentHash The canonical §8.1 intent hash to check.
    /// @return True iff the intent is APPROVED and within its deadline.
    function isUsable(bytes32 intentHash) external view returns (bool);
}

/// @title UntchVault
/// @author Untch
/// @notice PRD §10.4 / §7.5 — Mode C on-chain spend enforcement. An operator (`owner`) deposits an
/// ERC20 into the vault and binds it to an off-chain oracle key, per-tx / per-epoch caps, a token
/// allowlist, and optionally a required anchored SpendIntent (§10.2). Funds then leave ONLY through
/// one of three bounded paths:
///   1. `spend` — an EIP-712 oracle-signed authorization within all caps, with the anchored intent
///      APPROVED when the vault requires it;
///   2. `spendFallback` — an owner-triggered pre-committed micro-spend (oracle offline), bounded by an
///      owner-set per-recipient cap + the same epoch budget / token allowlist / pause guard;
///   3. `ownerWithdraw` — the owner's UNCONDITIONAL escape hatch (§16 I4), never gated by anything.
///
/// @dev CUSTODY POSTURE (§16 I4 — funds sovereignty, THE point of this contract). The oracle key
/// **cannot** withdraw funds or initiate arbitrary transfers: an oracle signature only authorizes a
/// spend the vault already permits by cap, epoch budget, token allowlist, single-use nonce, expiry,
/// and (when required) an APPROVED anchored intent — the oracle picks recipient/amount only WITHIN
/// that envelope. The owner can `pause` (halting both spend paths) and `ownerWithdraw` (unconditional,
/// never paused, no oracle) with nothing from Untch. This is enforced by the master invariant: no
/// token leaves the vault except a valid unexpired unused oracle sig + caps hold + (anchored-intent
/// APPROVED if required), OR ownerWithdraw, OR a fallback spend within its own bounds.
///
/// SIX RESOLVED JUDGMENT CALLS (full reasoning in contracts/README.md; summarized at each site):
///   1. NO timelock on setOracle/pause — plain owner-gating. A timelock would protect against nothing
///      a compromised owner key can't already do via the unconditional `ownerWithdraw`, and pause is an
///      emergency control that MUST be immediate. (Unlike §10.3 UntchReceipts, which had no
///      unconditional escape hatch and so needed a timelock as its only damage-limiter.)
///   2. USE OpenZeppelin `ECDSA` (vendored, verbatim v5.6.1) — its malleability guard (s ≤ n/2) closes
///      the single most common real signature-verification bug class. It holds no value and is scoped
///      to exactly signature recovery, so it PASSES the same evaluative test that REJECTED
///      TimelockController for §10.3 — importing it is consistent with that rejection, not a reversal.
///   3. USE OpenZeppelin `SafeERC20` — cheap insurance against non-bool-returning ERC20s; same
///      custody-free / single-purpose test. USDT0 is standard-compliant, but SafeERC20 costs little and
///      removes the bug class for any eventual token.
///   4. `intentRegistry` and the token allowlist are IMMUTABLE — a mutable one could silently redirect
///      the vault's trust to a third party (an attack). `owner`, by contrast, IS rotatable via a
///      two-step transfer: letting the sovereign rotate its own key adds no attacker capability (owner
///      compromise is already total via `ownerWithdraw`) and avoids permanently stranding funds on key
///      LOSS. "No setter in §10.4" is read as trust-redirection-prevention, not blanket immutability.
///   5. The cross-contract intent check FAILS CLOSED — a normal typed call, never try/catch; any
///      failure reverts the whole spend.
///   6. CHECKS-EFFECTS-INTERACTIONS — the cross-contract read AND all state mutations (nonce marked
///      used, epoch accounting committed) happen BEFORE the token transfer, which is strictly the last
///      operation. Reinforced by a reentrancy guard.
contract UntchVault {
    using SafeERC20 for IERC20;

    /// @notice The fund sovereign (§16 I4). MUTABLE, via a two-step transfer (`transferOwnership` →
    /// `acceptOwnership`). Judgment call 4 distinguishes two kinds of "no setter in §10.4": mutating
    /// `intentRegistry` / the token allowlist would silently REDIRECT the vault's trust to a third party
    /// (an attack surface — so those are immutable), whereas letting the owner rotate its OWN key adds no
    /// attacker capability (a compromised owner key is already total via the unconditional
    /// `ownerWithdraw`) and removes the permanent-loss-on-key-LOSS footgun. So owner rotation is
    /// supported; the two-step handshake prevents transferring ownership to a wrong/dead address.
    address public owner;

    /// @notice The pending owner set by `transferOwnership`; becomes `owner` only when it calls
    /// `acceptOwnership`. 0 = no transfer in flight.
    address public pendingOwner;

    /// @notice The SpendIntentRegistry (§10.2) this vault trusts for anchored-intent status. Immutable
    /// (judgment call 4 — a mutable one could redirect the vault's cross-contract trust). Only read when
    /// `requireAnchoredIntent` is true.
    ISpendIntentStatus public immutable intentRegistry;

    /// @notice Max amount a single oracle-path `spend` may move (§7.5 `amount>perTxCap ▶ CapExceeded`).
    uint256 public immutable perTxCap;

    /// @notice Max total that may be spent within one epoch, across BOTH spend paths (§7.5
    /// `epochSpent+amount>epochBudget ▶ BudgetExceeded`).
    uint256 public immutable epochBudget;

    /// @notice Epoch length in seconds. Epoch index of time `t` is `(t - epochGenesis) / epochLen`.
    uint64 public immutable epochLen;

    /// @notice Timestamp the epoch schedule is anchored to (this contract's construction time), so the
    /// epoch boundary is deterministic and independent of when the first spend happens.
    uint256 public immutable epochGenesis;

    /// @notice Whether `spend` must additionally require an APPROVED anchored intent (§7.5's
    /// policy-requires-anchored-intent branch). When false, the intent registry is never called.
    bool public immutable requireAnchoredIntent;

    /// @notice The oracle key whose EIP-712 signature authorizes a `spend`. Owner-settable
    /// (`setOracle`), immediate (judgment call 1). It can never withdraw or arbitrary-transfer — it only
    /// authorizes spends already bounded by cap/budget/allowlist/nonce/expiry/intent (§16 I4).
    address public oracle;

    /// @notice Whether spends are halted. `pause`/`unpause` are owner-only and immediate; pause blocks
    /// BOTH spend paths but NEVER `ownerWithdraw`.
    bool public paused;

    /// @notice Tokens the vault may spend/deposit. Fixed at construction (no setter — judgment call 4).
    mapping(address token => bool allowed) public tokenAllowed;

    /// @notice Single-use nonce set, keyed on the `nonce` FIELD inside the signed `Spend` struct — never
    /// derived from signature bytes, so signature malleability cannot mint a second usable nonce.
    mapping(uint256 nonce => bool used) public nonceUsed;

    /// @notice Owner-set fallback allowlist: per recipient, the max a single `spendFallback` may move to
    /// it. 0 = not allowlisted. Substitutes for the oracle path's `perTxCap` on the fallback path.
    mapping(address recipient => uint256 perTxMax) public fallbackPerTxMax;

    /// @notice The epoch whose spend total is currently held in `epochSpent`. Lazily rolled forward on
    /// the first spend of a new epoch.
    uint256 public currentEpoch;

    /// @notice Total spent so far within `currentEpoch`. Reset to 0 exactly when the epoch rolls over.
    uint256 public epochSpent;

    /// @dev Cached EIP-712 domain separator + the chainId it was built for. Recomputed on the fly if
    /// `block.chainid` ever differs (post-fork), so the domain's chainId is always the LIVE chain —
    /// never a hardcoded value that would enable cross-chain signature replay.
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    /// @dev Reentrancy mutex (1 = unlocked, 2 = entered). Hand-rolled, matching the repo's
    /// zero-dependency discipline for simple primitives; belt-and-suspenders atop strict CEI.
    uint256 private _entered;

    // The two constants below are EIP-712 type strings: their content is fixed by the standard and MUST
    // be verbatim (they define the hash the off-chain signer reproduces), so they are unavoidably longer
    // than 32 bytes. gas-small-strings is dispositioned over exactly these two keccak inputs.
    /* solhint-disable gas-small-strings */

    /// @notice EIP-712 domain type hash for `EIP712Domain(name, chainId, verifyingContract)`. No
    /// `version` field — §10.4 specifies the domain as `UntchVault(chainId, vault)`, name + chainId +
    /// verifying contract.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    /// @notice EIP-712 struct type hash for the §10.4 `Spend` authorization.
    bytes32 private constant SPEND_TYPEHASH = keccak256(
        "Spend(address recipient,uint256 amount,address token,bytes32 intentHash,uint256 nonce,uint256 expiry)"
    );

    /* solhint-enable gas-small-strings */

    /// @notice The EIP-712 domain name (§10.4 `UntchVault(chainId, vault)`), NOT the older
    /// AgentSpendVault.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("UntchVault");

    // The amount/perTxMax fields below are numeric values nobody filters logs by an exact match on
    // (range queries are impossible on indexed topics), so they are intentionally left in the data
    // section; the searchable dimensions (token, from/to/recipient, intentHash) ARE indexed. Same
    // spec-fidelity disposition of gas-indexed-events UntchReceipts (§10.3) made for its anchor events.
    /* solhint-disable gas-indexed-events */

    /// @notice Tokens were deposited into the vault.
    /// @param token The token deposited.
    /// @param from The account that funded the vault.
    /// @param amount The amount pulled in.
    event Deposit(address indexed token, address indexed from, uint256 amount);

    /// @notice A bounded spend left the vault (§7.5 `emit VaultSpend(...)`). `fallbackPath` distinguishes
    /// the oracle-signed path (false, `intentHash` is the authorized intent) from the owner fallback
    /// path (true, `intentHash` is 0 — no intent binds a fallback spend).
    /// @param recipient The payee funds went to.
    /// @param token The settlement token.
    /// @param intentHash The authorized intent (oracle path) or 0 (fallback path).
    /// @param amount The amount sent.
    /// @param nonce The single-use nonce (oracle path) or 0 (fallback path).
    /// @param fallbackPath True iff this was an owner fallback spend, false for the oracle-signed path.
    event VaultSpend(
        address indexed recipient,
        address indexed token,
        bytes32 indexed intentHash,
        uint256 amount,
        uint256 nonce,
        bool fallbackPath
    );

    /// @notice The owner withdrew tokens unconditionally (§16 I4 — never oracle-gated, never paused).
    /// @param token The token withdrawn.
    /// @param to The withdrawal recipient.
    /// @param amount The amount withdrawn.
    event OwnerWithdraw(address indexed token, address indexed to, uint256 amount);

    /// @notice The oracle key was changed (immediate; judgment call 1).
    /// @param previousOracle The prior oracle key (0 at construction).
    /// @param newOracle The new oracle key.
    event OracleChanged(address indexed previousOracle, address indexed newOracle);

    /// @notice A two-step ownership transfer was started; `newOwner` must call `acceptOwnership`.
    /// @param previousOwner The current owner that initiated the transfer.
    /// @param newOwner The proposed new owner (0 clears a pending transfer).
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /// @notice Ownership was transferred (the pending owner accepted).
    /// @param previousOwner The prior owner.
    /// @param newOwner The new owner.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Spends were paused by the owner.
    /// @param by The owner that paused.
    event Paused(address indexed by);

    /// @notice Spends were unpaused by the owner.
    /// @param by The owner that unpaused.
    event Unpaused(address indexed by);

    /// @notice A recipient's fallback per-tx cap was set (0 = removed from the fallback allowlist).
    /// @param recipient The fallback recipient.
    /// @param perTxMax The new per-tx cap for it (0 = removed).
    event FallbackAllowlistSet(address indexed recipient, uint256 perTxMax);

    /* solhint-enable gas-indexed-events */

    /// @notice Caller is not the owner.
    error NotOwner(address caller);

    /// @notice Caller is not the pending owner (only they may `acceptOwnership`).
    error NotPendingOwner(address caller);

    /// @notice The zero address was supplied where a real account is required.
    error ZeroAddress();

    /// @notice A required positive parameter was zero at construction.
    error ZeroValue();

    /// @notice `requireAnchoredIntent` was set true but no intent registry was supplied.
    error IntentRegistryRequired();

    /// @notice The token allowlist supplied at construction was empty — a vault that can spend nothing.
    error EmptyTokenAllowlist();

    /// @notice Reentrant call detected.
    error Reentrancy();

    // ── §7.5 enumerated revert reasons ──────────────────────────────────────────

    /// @notice Spends are paused (§7.5 `paused ▶ VaultPaused`).
    error VaultPaused();

    /// @notice The oracle signature is past its expiry (§7.5 `now>expiry ▶ SigExpired`).
    error SigExpired(uint256 expiry, uint256 nowTs);

    /// @notice The nonce has already been used (§7.5 `nonce used ▶ NonceReplay`).
    error NonceReplay(uint256 nonce);

    /// @notice The recovered signer is not the oracle (§7.5 `recover≠oracle ▶ BadOracle`).
    error BadOracle(address recovered, address expected);

    /// @notice The amount exceeds the per-tx cap (§7.5 `amount>perTxCap ▶ CapExceeded`). Reused by the
    /// fallback path for its per-recipient cap.
    error CapExceeded(uint256 amount, uint256 cap);

    /// @notice The epoch budget would be exceeded (§7.5 `epochSpent+amount>epochBudget ▶ BudgetExceeded`).
    error BudgetExceeded(uint256 wouldBe, uint256 budget);

    /// @notice The token is not on the allowlist (§7.5 `token ∉ allowlist ▶ TokenNotAllowed`).
    error TokenNotAllowed(address token);

    /// @notice The required anchored intent is not APPROVED / usable (§7.5 `…status≠APPROVED ▶
    /// IntentNotApproved`).
    error IntentNotApproved(bytes32 intentHash);

    /// @notice The recipient is not on the fallback allowlist (fallback path only).
    error FallbackRecipientNotAllowed(address recipient);

    /// @notice Restrict a call to the owner (§16 I4 owner-only surface).
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @notice Reentrancy guard — belt-and-suspenders atop CEI (judgment call 6). Deliberately NOT
    /// applied to `ownerWithdraw`, so nothing can ever block the unconditional escape hatch.
    modifier nonReentrant() {
        if (_entered == 2) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @notice Halt spends while paused; `ownerWithdraw` deliberately does NOT use this.
    modifier whenNotPaused() {
        if (paused) revert VaultPaused();
        _;
    }

    /// @notice Deploy a vault bound to an owner, oracle, caps, token allowlist, and (optionally) a
    /// required anchored-intent registry. Plain constructor — no factory / CREATE2 (that is the next,
    /// separate prompt). All trust anchors that §10.4's setter list omits (`owner`, `intentRegistry`,
    /// the token allowlist, the caps, `epochLen`, `requireAnchoredIntent`) are IMMUTABLE / write-once
    /// here (judgment call 4).
    /// @param _owner The fund sovereign; can pause and withdraw unconditionally.
    /// @param _oracle The initial oracle key whose EIP-712 sig authorizes spends.
    /// @param _intentRegistry SpendIntentRegistry (§10.2). Required (non-zero) iff `_requireAnchoredIntent`.
    /// @param _perTxCap Max per oracle-path spend (must be > 0).
    /// @param _epochBudget Max total spend per epoch across both paths (must be > 0).
    /// @param _epochLenSecs Epoch length in seconds (must be > 0 — it is a divisor).
    /// @param _tokenAllow The token allowlist (non-empty; no zero addresses). Fixed for the vault's life.
    /// @param _requireAnchoredIntent Whether `spend` also requires an APPROVED anchored intent.
    constructor(
        address _owner,
        address _oracle,
        address _intentRegistry,
        uint256 _perTxCap,
        uint256 _epochBudget,
        uint64 _epochLenSecs,
        address[] memory _tokenAllow,
        bool _requireAnchoredIntent
    ) {
        if (_owner == address(0) || _oracle == address(0)) {
            revert ZeroAddress();
        }
        if (_perTxCap == 0 || _epochBudget == 0 || _epochLenSecs == 0) revert ZeroValue();
        if (_tokenAllow.length == 0) revert EmptyTokenAllowlist();
        if (_requireAnchoredIntent && _intentRegistry == address(0)) {
            revert IntentRegistryRequired();
        }

        for (uint256 i = 0; i < _tokenAllow.length; ++i) {
            address t = _tokenAllow[i];
            if (t == address(0)) revert ZeroAddress();
            tokenAllowed[t] = true;
        }

        owner = _owner;
        oracle = _oracle;
        intentRegistry = ISpendIntentStatus(_intentRegistry);
        perTxCap = _perTxCap;
        epochBudget = _epochBudget;
        epochLen = _epochLenSecs;
        requireAnchoredIntent = _requireAnchoredIntent;

        // solhint-disable-next-line not-rely-on-time
        epochGenesis = block.timestamp;
        currentEpoch = 0;

        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();

        _entered = 1;

        emit OracleChanged(address(0), _oracle);
    }

    /// @notice Fund the vault with an allowlisted token (permissionless — anyone may top it up).
    /// @dev Pulls via `safeTransferFrom`, so a non-bool-returning ERC20 is handled correctly (judgment
    /// call 3). The vault holds token balances natively; there is no separate internal ledger to keep in
    /// sync (spends simply transfer out, reverting if the balance is insufficient).
    /// @param token The token to deposit (must be on the allowlist).
    /// @param amount The amount to pull from the caller.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (!tokenAllowed[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroValue();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(token, msg.sender, amount);
    }

    /// @notice Execute an oracle-authorized spend (§7.5, Mode C). Callable by anyone — the EIP-712
    /// oracle signature IS the capability; the caller merely relays it. Every §7.5 precondition is
    /// checked before any state changes, and the token transfer is strictly the last operation
    /// (judgment call 6, CEI).
    /// @dev Revert order mirrors §7.5: VaultPaused, SigExpired, NonceReplay, BadOracle, CapExceeded,
    /// BudgetExceeded, TokenNotAllowed, IntentNotApproved. The oracle signs over
    /// `(recipient, amount, token, intentHash, nonce, expiry)` so it authorizes exactly this transfer —
    /// it cannot redirect funds elsewhere. The anchored-intent check (when required) is a plain typed
    /// call to the immutable registry that FAILS CLOSED: any revert / bad return / no-code reverts the
    /// whole spend (judgment call 5).
    /// @param recipient The payee the oracle authorized.
    /// @param amount The amount to send (≤ perTxCap; must fit the epoch budget).
    /// @param token The settlement token (must be allowlisted).
    /// @param intentHash The bounded SpendIntent this spend settles (checked APPROVED iff required).
    /// @param oracleSig The oracle's EIP-712 signature over the `Spend` struct.
    /// @param nonce Single-use nonce (the signed field; not derived from signature bytes).
    /// @param expiry Unix second after which the signature is stale.
    function spend(
        address recipient,
        uint256 amount,
        address token,
        bytes32 intentHash,
        bytes calldata oracleSig,
        uint256 nonce,
        uint256 expiry
    ) external nonReentrant whenNotPaused {
        // solhint-disable-next-line not-rely-on-time
        uint256 nowTs = block.timestamp;
        // solhint-disable-next-line gas-strict-inequalities
        if (nowTs > expiry) revert SigExpired(expiry, nowTs);
        if (nonceUsed[nonce]) revert NonceReplay(nonce);

        bytes32 digest = _spendDigest(recipient, amount, token, intentHash, nonce, expiry);
        address signer = ECDSA.recover(digest, oracleSig);
        if (signer != oracle) revert BadOracle(signer, oracle);

        if (amount > perTxCap) revert CapExceeded(amount, perTxCap);
        (uint256 epoch, uint256 rolledSpent) = _epochView(nowTs);
        uint256 wouldBe = rolledSpent + amount;
        if (wouldBe > epochBudget) revert BudgetExceeded(wouldBe, epochBudget);
        if (!tokenAllowed[token]) revert TokenNotAllowed(token);

        // ── EFFECTS (all state committed before ANY external call — strict CEI, judgment call 6) ──
        nonceUsed[nonce] = true;
        currentEpoch = epoch;
        epochSpent = wouldBe;

        // ── INTERACTIONS (every external call is here, after effects) ──
        // The anchored-intent check reads the immutable registry. It sits AFTER the effects so no state
        // write follows an external call (strict CEI). It still fails CLOSED (judgment call 5): a plain
        // typed call, no try/catch — any revert / bad return / no-code reverts the whole spend, rolling
        // the effects back. It is a `view` call (STATICCALL — the registry cannot reenter or mutate) and
        // the reentrancy guard covers it regardless; the token transfer remains strictly last.
        if (requireAnchoredIntent && !intentRegistry.isUsable(intentHash)) {
            revert IntentNotApproved(intentHash);
        }
        IERC20(token).safeTransfer(recipient, amount);
        emit VaultSpend(recipient, token, intentHash, amount, nonce, false);
    }

    /// @notice Execute a pre-committed fallback micro-spend when the oracle is offline (§7.5 "Fallback").
    /// Owner-only: the fallback grants NO capability the owner does not already have via the
    /// unconditional `ownerWithdraw`, so gating it to the owner preserves §16 I4 exactly while adding
    /// allowlist / epoch-budget / token-allowlist discipline and an auditable `VaultSpend` receipt to
    /// the owner's contingency spends.
    /// @dev Guards that STILL apply (vs the oracle path): pause (VaultPaused), token allowlist
    /// (TokenNotAllowed), epoch budget (BudgetExceeded). Guards SUBSTITUTED: the oracle
    /// signature/nonce/expiry/intent-approval are replaced by the owner-pre-committed per-recipient cap
    /// (`fallbackPerTxMax`). CEI holds identically — epoch state is committed before the transfer.
    /// @param recipient The pre-approved payee (must have a non-zero fallback cap).
    /// @param amount The amount to send (≤ the recipient's fallback cap; must fit the epoch budget).
    /// @param token The settlement token (must be allowlisted).
    function spendFallback(address recipient, uint256 amount, address token)
        external
        nonReentrant
        whenNotPaused
        onlyOwner
    {
        uint256 cap = fallbackPerTxMax[recipient];
        if (cap == 0) revert FallbackRecipientNotAllowed(recipient);
        if (amount == 0) revert ZeroValue();
        if (amount > cap) revert CapExceeded(amount, cap);
        if (!tokenAllowed[token]) revert TokenNotAllowed(token);

        // solhint-disable-next-line not-rely-on-time
        (uint256 epoch, uint256 rolledSpent) = _epochView(block.timestamp);
        uint256 wouldBe = rolledSpent + amount;
        if (wouldBe > epochBudget) revert BudgetExceeded(wouldBe, epochBudget);

        // ── EFFECTS ──
        currentEpoch = epoch;
        epochSpent = wouldBe;

        // ── INTERACTION (strictly last) ──
        IERC20(token).safeTransfer(recipient, amount);
        emit VaultSpend(recipient, token, bytes32(0), amount, 0, true);
    }

    /// @notice The owner's UNCONDITIONAL withdrawal (§7.5 `ownerWithdraw(): always available, no
    /// oracle`; §16 I4). Never paused, never oracle-gated, never reentrancy-blocked, no allowlist check —
    /// so the owner can always recover any token (including one accidentally sent here) with nothing from
    /// Untch. It does NOT touch epoch accounting: it is not a policy spend, it is the sovereign exit.
    /// @param token The token to withdraw.
    /// @param to The recipient of the withdrawal.
    /// @param amount The amount to withdraw.
    function ownerWithdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit OwnerWithdraw(token, to, amount);
    }

    /// @notice Start a two-step transfer of ownership (owner-only, judgment call 4). Records
    /// `pendingOwner`; the transfer completes only when `newOwner` calls `acceptOwnership`, so ownership
    /// can never be handed to a wrong/dead address that cannot claim it. Passing the zero address clears
    /// any pending transfer. This is a recovery path (rotate a lost/rotated owner key), NOT a new
    /// attacker capability — a compromised owner is already total via `ownerWithdraw`.
    /// @param newOwner The proposed new owner (0 to cancel a pending transfer).
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete a two-step ownership transfer (pending-owner-only). Sets `owner`, clears
    /// `pendingOwner`.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    /// @notice Rotate the oracle key (owner-only, immediate — judgment call 1). Rejects the zero address
    /// (which would silently disable the oracle path).
    /// @param newOracle The new oracle key.
    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        address previous = oracle;
        oracle = newOracle;
        emit OracleChanged(previous, newOracle);
    }

    /// @notice Halt both spend paths (owner-only, immediate). `ownerWithdraw` remains available.
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume spends (owner-only, immediate).
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Set (or clear, with 0) a recipient's fallback per-tx cap (owner-only). This is the owner's
    /// pre-commitment that keeps bounded micro-spends alive while the oracle is offline.
    /// @param recipient The fallback recipient.
    /// @param perTxMax The max a single `spendFallback` may send it; 0 removes it from the allowlist.
    function setFallbackAllowlist(address recipient, uint256 perTxMax) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        fallbackPerTxMax[recipient] = perTxMax;
        emit FallbackAllowlistSet(recipient, perTxMax);
    }

    /// @notice The live EIP-712 domain separator, always built for the CURRENT chainId (never hardcoded).
    /// @dev Returns the cached value on the chain it was built for; recomputes after a fork so the
    /// domain's `chainId` tracks `block.chainid`, preventing cross-chain signature replay.
    /// @return The domain separator for `block.chainid`.
    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return _buildDomainSeparator();
    }

    /// @notice The EIP-712 digest the oracle signs for a given spend — exposed so off-chain signers and
    /// tests derive the exact same bytes the contract verifies.
    /// @param recipient The payee.
    /// @param amount The amount.
    /// @param token The token.
    /// @param intentHash The bounded intent hash.
    /// @param nonce The single-use nonce.
    /// @param expiry The signature expiry.
    /// @return The EIP-712 digest.
    function spendDigest(
        address recipient,
        uint256 amount,
        address token,
        bytes32 intentHash,
        uint256 nonce,
        uint256 expiry
    ) external view returns (bytes32) {
        return _spendDigest(recipient, amount, token, intentHash, nonce, expiry);
    }

    /// @notice The epoch index of a timestamp, per the vault's fixed schedule.
    /// @param ts The timestamp to classify.
    /// @return The epoch index (`(ts - epochGenesis) / epochLen`).
    function epochOf(uint256 ts) external view returns (uint256) {
        return (ts - epochGenesis) / epochLen;
    }

    /// @dev The epoch index of `ts` and the epoch-spent total to compare against the budget: the stored
    /// `epochSpent` if still in `currentEpoch`, otherwise 0 (a rolled-over epoch starts fresh). Pure view
    /// of `block.timestamp`; the caller commits `currentEpoch`/`epochSpent` in its effects section.
    /// @dev `epoch > currentEpoch` (not `epoch == currentEpoch`) intentionally: `block.timestamp` is
    /// monotonic, so `epoch(now) >= currentEpoch` always holds and `> ` is the strictly-later-epoch test.
    /// This is equivalent to an inequality on epoch indices, not a strict equality on a manipulable value.
    function _epochView(uint256 ts) private view returns (uint256 epoch, uint256 rolledSpent) {
        epoch = (ts - epochGenesis) / epochLen;
        // solhint-disable-next-line gas-strict-inequalities
        rolledSpent = epoch > currentEpoch ? 0 : epochSpent;
    }

    /// @dev Build the EIP-712 digest for a `Spend`. The domain binds `block.chainid` and this vault's
    /// address; the struct binds every spend parameter. `\x19\x01` prefix per EIP-712.
    function _spendDigest(
        address recipient,
        uint256 amount,
        address token,
        bytes32 intentHash,
        uint256 nonce,
        uint256 expiry
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(SPEND_TYPEHASH, recipient, amount, token, intentHash, nonce, expiry)
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// @dev Construct the domain separator from the LIVE `block.chainid` and this vault's address.
    function _buildDomainSeparator() private view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, block.chainid, address(this)));
    }
}
