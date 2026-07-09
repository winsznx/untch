// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { Scaffold } from "../src/Scaffold.sol";

contract ScaffoldTest is Test {
    Scaffold internal scaffold;

    address internal owner = address(this);
    address internal stranger = address(0xBEEF);

    event ValueUpdated(address indexed by, uint256 indexed oldValue, uint256 indexed newValue);

    function setUp() public {
        scaffold = new Scaffold();
    }

    /// @notice Happy path: owner updates `value` and the event fires with old/new.
    function test_OwnerCanSetValue() public {
        assertEq(scaffold.value(), 0);

        vm.expectEmit(true, true, true, true, address(scaffold));
        emit ValueUpdated(owner, 0, 42);
        scaffold.setValue(42);

        assertEq(scaffold.value(), 42);
    }

    /// @notice Revert path: a non-owner cannot update `value`.
    function test_RevertWhen_NonOwnerSetsValue() public {
        vm.prank(stranger);
        vm.expectRevert(Scaffold.NotOwner.selector);
        scaffold.setValue(7);
    }

    /// @notice Revert path: the pause switch blocks `setValue` even for the owner.
    function test_RevertWhen_SetValueWhilePaused() public {
        scaffold.pause();
        assertTrue(scaffold.paused());

        vm.expectRevert(Scaffold.EnforcedPause.selector);
        scaffold.setValue(7);
    }
}
