// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";

contract TestBits {
    bytes32[3] private _data;

    function setState(uint8 state) public {
        bytes32 slot2 = _data[2];
        uint256 mask = ~uint256(0xFF << 160);
        slot2 = bytes32((uint256(slot2) & mask) | (uint256(state) << 160));
        _data[2] = slot2;
    }

    function getState() public view returns (uint8) {
        return uint8(uint256(_data[2]) >> 160);
    }

    function setSwapExecuted(bool executed) public {
        bytes32 slot2 = _data[2];
        uint256 mask = ~uint256(0xFF << 168);
        slot2 = bytes32((uint256(slot2) & mask) | (uint256(executed ? 1 : 0) << 168));
        _data[2] = slot2;
    }

    function getSwapExecuted() public view returns (bool) {
        return uint8(uint256(_data[2]) >> 168) != 0;
    }
}

contract BitManipulationTest is Test {
    TestBits public testContract;

    function setUp() public {
        testContract = new TestBits();
    }

    function test_StateSetAndGet() public {
        // Set state to 1
        testContract.setState(1);
        assertEq(testContract.getState(), 1, "State should be 1");

        // Set state to 2
        testContract.setState(2);
        assertEq(testContract.getState(), 2, "State should be 2");
    }

    function test_StatePreservedWhenSettingSwapExecuted() public {
        // Set state to 1
        testContract.setState(1);
        assertEq(testContract.getState(), 1, "Initial state should be 1");

        // Set swapExecuted to true
        testContract.setSwapExecuted(true);

        // State should still be 1
        assertEq(testContract.getState(), 1, "State should still be 1 after setting swapExecuted");
        assertEq(testContract.getSwapExecuted(), true, "SwapExecuted should be true");
    }

    function test_FullSequence() public {
        // Initial state should be 0
        assertEq(testContract.getState(), 0, "Initial state");
        assertEq(testContract.getSwapExecuted(), false, "Initial swapExecuted");

        // Set state to SWAP (1)
        testContract.setState(1);
        assertEq(testContract.getState(), 1, "After setState(1)");

        // Set swapExecuted
        testContract.setSwapExecuted(true);
        assertEq(testContract.getState(), 1, "State after setSwapExecuted");
        assertEq(testContract.getSwapExecuted(), true, "swapExecuted should be true");

        // Set state to COMPLETED (2)
        testContract.setState(2);
        assertEq(testContract.getState(), 2, "After setState(2)");
        assertEq(testContract.getSwapExecuted(), true, "swapExecuted should still be true");
    }
}
