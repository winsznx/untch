// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title Scaffold
/// @author Untch
/// @notice Throwaway D0.4 toolchain target — a minimal ownable + pausable stub that gives
/// the static analyzers (Slither, Aderyn, solhint) real surface to inspect: access
/// control, a pause switch, a guarded state mutation, and an event. This is NOT a product
/// contract; it exists only to prove the §28 audit pipeline runs green, and it anchors the
/// D0.5 project structure. Do not build features on it.
contract Scaffold {
    /// @notice Account allowed to pause/unpause and to update `value`.
    /// @dev Immutable: this stub has no ownership-transfer path, so the owner is fixed at
    /// construction. Access control (`onlyOwner`) is unaffected.
    address public immutable owner;

    /// @notice While true, `setValue` reverts. Pause/unpause stay available to the owner.
    bool public paused;

    /// @notice The single guarded value this stub exposes.
    uint256 public value;

    /// @notice Emitted whenever `value` changes.
    /// @dev All three fields are indexed so log consumers can filter by actor or by exact
    /// old/new value (uses the full 3-topic budget; also clears the analyzers'
    /// indexed-event suggestions).
    /// @param by Account that performed the update (always the owner).
    /// @param oldValue Value before the update.
    /// @param newValue Value after the update.
    event ValueUpdated(address indexed by, uint256 indexed oldValue, uint256 indexed newValue);

    /// @notice Caller is not the owner.
    error NotOwner();

    /// @notice Action is blocked while the contract is paused.
    error EnforcedPause();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice The one guarded setter: owner-only and blocked while paused.
    /// @param newValue Replacement value for `value`.
    function setValue(uint256 newValue) external onlyOwner whenNotPaused {
        uint256 previous = value;
        value = newValue;
        emit ValueUpdated(msg.sender, previous, newValue);
    }

    /// @notice Owner halts `setValue`.
    function pause() external onlyOwner {
        paused = true;
    }

    /// @notice Owner resumes `setValue`.
    function unpause() external onlyOwner {
        paused = false;
    }
}
