// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { UntchVault } from "./UntchVault.sol";

/// @title UntchVaultFactory
/// @author Untch
/// @notice PRD §10.4 — the CREATE2 factory that deploys `UntchVault` (§10.4 / §7.5) instances at
/// addresses deterministic per `(owner, agent)`. It is the LAST contract in the on-chain set
/// (PolicyRegistry §10.1, SpendIntentRegistry §10.2, UntchReceipts §10.3, UntchVault §10.4, this).
///
/// @dev THE FACTORY HOLDS NO FUNDS AND MOVES NO MONEY. It has exactly one job: deploy a vault. There is
/// no deposit / spend / withdraw path here — those live in `UntchVault`, which is the only fund-holding
/// contract. The factory never becomes `owner` or `oracle` of any vault; it only relays construction.
///
/// THREE RESOLVED DECISIONS (full reasoning in contracts/README.md; summarized at each site):
///   A. SPEC-DRIFT — §10.4's written signature
///      `deployVault(owner, agent, oracle, perTxCap, epochBudget, epochLenSecs, tokenAllow[],
///      requireAnchoredIntent)` predates UntchVault's cross-contract IntentRegistry integration, whose
///      constructor now takes an immutable `intentRegistry`. The drift is reconciled WITHOUT adding a
///      per-call parameter: the factory holds ONE canonical `intentRegistry` (decision B) and injects it
///      into every vault, so `deployVault`'s signature stays VERBATIM as §10.4 wrote it. `agent` — which
///      the vault constructor does NOT take — is repurposed as the CREATE2 salt seed ("deterministic per
///      agent"), never a vault constructor argument.
///   B. `intentRegistry` IS FACTORY-CANONICAL AND IMMUTABLE — set once at the factory's construction,
///      used for every vault. NOT a per-call parameter. There is one canonical SpendIntentRegistry for
///      the whole system; a per-call registry would let a caller (mistakenly or maliciously) point a
///      vault at a rogue registry, redirecting the vault's cross-contract trust. This extends UntchVault's
///      own judgment call 4 (`intentRegistry` immutable to prevent trust-redirection) to the deployment
///      layer: the rules of the game are not alterable per-instance.
///   C. CREATE2 SALT = keccak256(owner, agent) AND access control = permissionless-but-`owner ==
///      msg.sender`. Salt binds the `(owner, agent)` pair the §10.4 hard rule names as the uniqueness
///      key, so the same agent can be operated under different owners (self-service, no cross-owner
///      pre-emption of an agent-only salt slot). Deployment is permissionless (no allowlist / admin /
///      fee), but `owner` must equal the caller: each account deploys only its OWN sovereign-owned vault,
///      which makes the deterministic `(owner, agent)` address non-griefable (no one can squat another
///      account's vault address with immutable caps it did not choose).
contract UntchVaultFactory {
    /// @notice The canonical SpendIntentRegistry (§10.2) every vault this factory deploys is bound to.
    /// Immutable, set once here (decision B) — never a `deployVault` parameter. Vaults deployed with
    /// `requireAnchoredIntent == false` still receive it but never call it (harmless).
    address public immutable intentRegistry;

    /// @notice A vault was deployed. `owner`/`agent` are the salt inputs (decision C); `vault` is the
    /// deterministic address `computeVaultAddress(...)` predicts for the same inputs.
    /// @param owner The vault's fund sovereign (== the caller — decision C).
    /// @param agent The per-agent salt seed (not a vault constructor argument — decision A).
    /// @param vault The deployed vault address.
    /// @param oracle The vault's initial oracle key.
    /// @param requireAnchoredIntent Whether the vault requires an APPROVED anchored intent to spend.
    event VaultDeployed(
        address indexed owner,
        address indexed agent,
        address indexed vault,
        address oracle,
        bool requireAnchoredIntent
    );

    /// @notice The zero address was supplied where a real account is required.
    error ZeroAddress();

    /// @notice `owner` did not equal the caller (decision C — you may only deploy your OWN vault).
    error OwnerMustBeSender(address owner, address caller);

    /// @notice A vault already exists at the deterministic address for this `(owner, agent)` — the
    /// double-deployment guard. Surfaced when CREATE2's own zero-return is traced to an already-occupied
    /// target (not a bespoke pre-check: the deployment is attempted first, and this only classifies the
    /// failure). See `deployVault`.
    error VaultAlreadyDeployed(address owner, address agent);

    /// @notice CREATE2 returned the zero address for a reason OTHER than an occupied target — i.e. the
    /// vault's own constructor reverted on the supplied arguments (e.g. a zero oracle, a zero cap, an
    /// empty allowlist). The specific vault reason is not recoverable through `create2` (the EVM discards
    /// a creation revert's data); predict + validate arguments off-chain before deploying.
    error VaultDeploymentFailed(address owner, address agent);

    /// @notice Deploy a new `UntchVault` at the CREATE2 address deterministic for `(owner, agent)`
    /// (§10.4). Permissionless, but `owner` MUST equal the caller (decision C). The vault is wired to the
    /// factory's canonical `intentRegistry` (decision B); the §10.4 signature is otherwise verbatim
    /// (decision A). Redeploying to the same `(owner, agent)` reverts naturally: the CREATE2 address
    /// already holds code, so the EVM's `create2` cannot deploy there (see the `new` note below).
    /// @dev Deployment uses raw `create2` over the EXACT bytes `_vaultInitCode(...)` returns, and
    /// `computeVaultAddress` hashes those SAME bytes — a single source of truth, so a prediction can
    /// never silently diverge from where the deployment lands (the fuzz test proves this across random
    /// inputs). CREATE2's address is `keccak256(0xff, factory, salt, keccak256(initCode))`: because the
    /// vault's config is embedded in `initCode` (its constructor args, which the vault stores as
    /// immutables), the address commits to BOTH the `(owner, agent)` salt AND the full config — so a
    /// caller cannot predict with one config and have a differently-configured vault land there.
    ///
    /// DOUBLE-DEPLOYMENT: `create2` returns the zero address when it cannot deploy. A repeat
    /// `(owner, agent)` with the SAME config targets an address that already holds code, so `create2`
    /// returns zero — CREATE2's natural collision behavior, no bespoke pre-check. The zero-return is then
    /// CLASSIFIED (only on the failure path) into a clear reason: an occupied target ⇒ `VaultAlreadyDeployed`,
    /// otherwise a vault-constructor revert ⇒ `VaultDeploymentFailed`. (A repeat pair with a DIFFERENT
    /// config produces a different `initCode` hash and therefore a different address — CREATE2 cannot
    /// collide distinct initcode; access control (decision C) means only `owner` itself could ever create
    /// such a variant of its own vault, so this is not a third-party griefing surface.)
    /// @param owner The vault's fund sovereign; MUST equal `msg.sender`.
    /// @param agent The per-agent salt seed (part of the CREATE2 salt; not a vault constructor argument).
    /// @param oracle The initial oracle key whose EIP-712 signature authorizes spends.
    /// @param perTxCap Max per oracle-path spend (must be > 0 — validated by the vault constructor).
    /// @param epochBudget Max total spend per epoch across both paths (must be > 0).
    /// @param epochLenSecs Epoch length in seconds (must be > 0).
    /// @param tokenAllow The token allowlist (non-empty; no zero addresses).
    /// @param requireAnchoredIntent Whether `spend` also requires an APPROVED anchored intent.
    /// @return vault The deployed vault's address (equals the pre-deployment prediction).
    function deployVault(
        address owner,
        address agent,
        address oracle,
        uint256 perTxCap,
        uint256 epochBudget,
        uint64 epochLenSecs,
        address[] calldata tokenAllow,
        bool requireAnchoredIntent
    ) external returns (address vault) {
        if (owner != msg.sender) {
            revert OwnerMustBeSender(owner, msg.sender);
        }
        if (agent == address(0)) revert ZeroAddress();

        bytes memory initCode = _vaultInitCode(
            owner, oracle, perTxCap, epochBudget, epochLenSecs, tokenAllow, requireAnchoredIntent
        );
        bytes32 salt = _salt(owner, agent);

        // solhint-disable-next-line no-inline-assembly
        assembly {
            vault := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }

        if (vault == address(0)) {
            // Classify CREATE2's natural zero-return AFTER the fact (not a pre-check gating deployment):
            // if the deterministic target already holds code, this was the double-deployment collision.
            if (_computeAddress(salt, keccak256(initCode)).code.length != 0) {
                revert VaultAlreadyDeployed(owner, agent);
            }
            revert VaultDeploymentFailed(owner, agent);
        }

        emit VaultDeployed(owner, agent, vault, oracle, requireAnchoredIntent);
    }

    /// @notice Predict the address `deployVault` will deploy to for the given inputs, BEFORE deploying
    /// (§10.4). Pure function of `(this factory, salt(owner, agent), keccak256(vault initcode))`; the
    /// initcode embeds the factory's canonical `intentRegistry` (decision B) exactly as `deployVault`
    /// does, so a prediction cannot silently disagree with the deployment for the same arguments.
    /// @param owner The vault's fund sovereign (salt input; also a constructor argument).
    /// @param agent The per-agent salt seed.
    /// @param oracle The initial oracle key.
    /// @param perTxCap Max per oracle-path spend.
    /// @param epochBudget Max total spend per epoch.
    /// @param epochLenSecs Epoch length in seconds.
    /// @param tokenAllow The token allowlist.
    /// @param requireAnchoredIntent Whether an APPROVED anchored intent is required.
    /// @return The address at which those exact inputs would deploy.
    function computeVaultAddress(
        address owner,
        address agent,
        address oracle,
        uint256 perTxCap,
        uint256 epochBudget,
        uint64 epochLenSecs,
        address[] calldata tokenAllow,
        bool requireAnchoredIntent
    ) external view returns (address) {
        bytes32 initCodeHash = keccak256(
            _vaultInitCode(
                owner,
                oracle,
                perTxCap,
                epochBudget,
                epochLenSecs,
                tokenAllow,
                requireAnchoredIntent
            )
        );
        return _computeAddress(_salt(owner, agent), initCodeHash);
    }

    /// @notice Bind the factory to the one canonical SpendIntentRegistry (§10.2) every vault will trust
    /// (decision B). Immutable thereafter.
    /// @param _intentRegistry The canonical registry address (must be non-zero — it is THE system
    /// registry; a factory that could mint vaults pointed at address(0) would be a footgun).
    constructor(address _intentRegistry) {
        if (_intentRegistry == address(0)) revert ZeroAddress();
        intentRegistry = _intentRegistry;
    }

    /// @dev The vault's CREATE2 initcode: its creation bytecode followed by the ABI-encoded constructor
    /// arguments, IN THE VAULT'S CONSTRUCTOR ORDER `(owner, oracle, intentRegistry, perTxCap, epochBudget,
    /// epochLenSecs, tokenAllow, requireAnchoredIntent)` — note `agent` is NOT here (it is only a salt
    /// seed, decision A) and `intentRegistry` is the factory's canonical immutable (decision B), the sole
    /// wiring point that reconciles the spec drift. This is the ONE place initcode is built; both
    /// `deployVault` (deploys these exact bytes) and `computeVaultAddress` (hashes them) call it, so
    /// prediction and deployment cannot diverge.
    function _vaultInitCode(
        address owner,
        address oracle,
        uint256 perTxCap,
        uint256 epochBudget,
        uint64 epochLenSecs,
        address[] calldata tokenAllow,
        bool requireAnchoredIntent
    ) private view returns (bytes memory) {
        // `bytes.concat` (not `abi.encodePacked`): both operands are already `bytes`, so this is a plain
        // byte concatenation — the canonical CREATE2 initcode (fixed-length creation bytecode followed by
        // the self-delimiting `abi.encode` of the constructor args). It is byte-identical to what
        // `new UntchVault(...)` builds. `abi.encodePacked` here would be a false-positive hash-collision
        // flag: the creationCode prefix is a compile-time constant length and `abi.encode` is unambiguous,
        // so no boundary ambiguity exists — but `bytes.concat` states the intent (concatenate two blobs)
        // and is the tool-recommended form.
        return bytes.concat(
            type(UntchVault).creationCode,
            abi.encode(
                owner,
                oracle,
                intentRegistry,
                perTxCap,
                epochBudget,
                epochLenSecs,
                tokenAllow,
                requireAnchoredIntent
            )
        );
    }

    /// @dev The EIP-1014 CREATE2 address for this factory: `keccak256(0xff ++ factory ++ salt ++
    /// keccak256(initCode))`, truncated to 20 bytes.
    function _computeAddress(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                )
            )
        );
    }

    /// @dev The CREATE2 salt for a vault: keccak256 over the `(owner, agent)` pair (decision C). Uses
    /// `abi.encode` (not `abi.encodePacked`) — two fixed-width addresses, laid out as two padded words,
    /// so the pair boundary is unambiguous and no two distinct pairs can collide.
    function _salt(address owner, address agent) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, agent));
    }
}
