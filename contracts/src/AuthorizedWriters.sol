// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title AuthorizedWriters
/// @author Untch
/// @notice Shared admin-managed authorized-writer allowlist for Untch's write-gated registries
/// (PRD §10.2 SpendIntentRegistry, §10.3 UntchReceipts). It factors out the exact access-control
/// primitive both contracts need: an `admin` role that manages a rotatable set of `writer`
/// addresses permitted to mutate the contract, where writers hold no funds and authorize no
/// transfer — they "sign only into the event log" (§16, "Writer key abuse" row).
/// @dev EXTRACTION, not reinvention: `SpendIntentRegistry` (§10.2) shipped this logic inline and
/// is deployed + tested on X Layer testnet; `UntchReceipts` (§10.3) needs the identical allowlist.
/// Rather than write it a third time when `UntchVault` lands, it lives here once and is proven by
/// SpendIntentRegistry's unchanged 86-test suite plus UntchReceipts' own suite.
///
/// Deliberately INTERNAL-ONLY mutators. This base exposes NO external `addWriter` / `removeWriter`
/// / `transferAdmin` — it provides `_addWriter` / `_removeWriter` / `_transferAdmin` (each carrying
/// the full guard + event) and lets each derived contract choose how to surface them:
///   • SpendIntentRegistry (§10.2) wraps them in plain `onlyAdmin` externals — IMMEDIATE, matching
///     its deployed, testnet-verified behavior (its admin is deliberately un-timelocked for the
///     first pass; see its README decisions).
///   • UntchReceipts (§10.3) routes them through a propose→delay→execute timelock — §10.3's spec
///     explicitly requires "admin behind timelock", so its admin actions are NOT immediate.
/// If this base exposed an immediate external mutator, UntchReceipts would inherit an
/// un-timelocked bypass of its own timelock. Keeping the external surface in the derived contracts
/// is what makes the two access-control postures a deliberate per-contract choice rather than an
/// accident of inheritance.
///
/// Custody posture (§16 I4): this base stores only an admin address and an allowlist. It holds no
/// funds and defines no `payable` / `receive` / `fallback`. Neither derived registry does either.
abstract contract AuthorizedWriters {
    /// @notice The account that manages the authorized writer set (add/remove writers, transfer
    /// admin). Set to the deployer at construction. This is the §10.3 "admin" role.
    address public admin;

    /// @notice The authorized writer set — addresses a derived contract permits to mutate it.
    /// @dev The writer key can only write into the derived contract's log/state; it holds no funds
    /// and authorizes no transfer (§16: "writer signs only into event log"). `admin` and `writer`
    /// are separate roles (least privilege): the admin manages the set but is not a writer by
    /// default — authorizing a writer is always an explicit `_addWriter`.
    mapping(address writer => bool authorized) public isWriter;

    /// @notice An address was granted writer authorization.
    /// @param writer The newly authorized writer.
    /// @param admin The admin that granted it.
    event WriterAdded(address indexed writer, address indexed admin);

    /// @notice An address had its writer authorization revoked.
    /// @param writer The de-authorized writer.
    /// @param admin The admin that revoked it.
    event WriterRemoved(address indexed writer, address indexed admin);

    /// @notice The admin role was transferred.
    /// @param previousAdmin The prior admin.
    /// @param newAdmin The new admin.
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    /// @notice `caller` is not an authorized writer.
    error NotWriter(address caller);

    /// @notice `caller` is not the admin.
    error NotAdmin(address caller);

    /// @notice The zero address was supplied where a real account is required.
    error ZeroAddress();

    /// @notice `writer` is already authorized — reject rather than silently no-op.
    error AlreadyWriter(address writer);

    /// @notice `writer` is not currently authorized — reject rather than silently no-op.
    error NotAuthorizedWriter(address writer);

    /// @notice Restrict a call to an authorized writer.
    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert NotWriter(msg.sender);
        _;
    }

    /// @notice Restrict a call to the admin.
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    /// @notice Establish the deployer as the initial admin.
    /// @dev The admin manages the writer set but is NOT itself a writer by default (least
    /// privilege): mutating a derived registry requires an explicit `_addWriter`. There is
    /// deliberately no initial-writer constructor arg — the writer set is always established through
    /// the audited add-writer path (immediate in §10.2, timelocked in §10.3).
    constructor() {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    /// @notice Grant writer authorization to `writer` (guarded core; callers gate the entry point).
    /// @dev Reverts on the zero address and on an already-authorized writer (no silent no-op). Emits
    /// the actor as `msg.sender`; every path that reaches here is `onlyAdmin`, so `msg.sender` is the
    /// admin whether the call is immediate (§10.2) or a timelocked execute (§10.3).
    /// @param writer The address to authorize.
    function _addWriter(address writer) internal {
        if (writer == address(0)) revert ZeroAddress();
        if (isWriter[writer]) revert AlreadyWriter(writer);
        isWriter[writer] = true;
        emit WriterAdded(writer, msg.sender);
    }

    /// @notice Revoke writer authorization from `writer` (guarded core; callers gate the entry point).
    /// @dev Reverts if the address is not currently a writer (no silent no-op).
    /// @param writer The address to de-authorize.
    function _removeWriter(address writer) internal {
        if (!isWriter[writer]) revert NotAuthorizedWriter(writer);
        isWriter[writer] = false;
        emit WriterRemoved(writer, msg.sender);
    }

    /// @notice Transfer the admin role to `newAdmin` (guarded core; callers gate the entry point).
    /// @dev Reverts on the zero address (which would brick writer-set management). Admin and writer
    /// are separate roles: transferring admin does not change the writer set.
    /// @param newAdmin The address to become admin.
    function _transferAdmin(address newAdmin) internal {
        if (newAdmin == address(0)) revert ZeroAddress();
        address previousAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(previousAdmin, newAdmin);
    }
}
