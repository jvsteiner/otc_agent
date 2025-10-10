// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../src/optimized/UnicitySwapEscrowImplementation.sol";
import "../../src/optimized/UnicitySwapEscrowImplementationArray.sol";
import "../../src/mocks/MockERC20.sol";

/**
 * @title ArrayStorageGasTest
 * @notice Gas comparison: Named storage variables vs bytes32[5] array
 * @dev Measures deployment and execution costs for both implementations
 */
contract ArrayStorageGasTest is Test {
    // Test token
    MockERC20 token;

    // Test addresses
    address payable alice = payable(address(0x1111));
    address payable bob = payable(address(0x2222));
    address operator = address(0x0000000000000000000000000000000000000001);

    function setUp() public {
        // Deploy token with 18 decimals
        token = new MockERC20("Test Token", "TEST", 18);

        // Fund test addresses
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        token.mint(alice, 1000000e18);
    }

    /*//////////////////////////////////////////////////////////////
                        HELPER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function deployNamedStorageEscrow() internal returns (UnicitySwapEscrowImplementation) {
        UnicitySwapEscrowImplementation escrow = new UnicitySwapEscrowImplementation();
        escrow.initialize(alice, bob, address(token), 1000e18, 3e18);
        return escrow;
    }

    function deployArrayStorageEscrow() internal returns (UnicitySwapEscrowImplementationArray) {
        UnicitySwapEscrowImplementationArray escrow = new UnicitySwapEscrowImplementationArray();
        escrow.initialize(alice, bob, address(token), 1000e18, 3e18);
        return escrow;
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON TESTS
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_Deployment() public {
        console.log("\n=== GAS COMPARISON: DEPLOYMENT ===");

        // Named storage deployment
        uint256 gasBefore = gasleft();
        UnicitySwapEscrowImplementation escrowNamed = deployNamedStorageEscrow();
        uint256 gasNamed = gasBefore - gasleft();

        // Array storage deployment
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationArray escrowArray = deployArrayStorageEscrow();
        uint256 gasArray = gasBefore - gasleft();

        // Report results
        console.log("Named storage deployment:", gasNamed);
        console.log("Array storage deployment:", gasArray);

        if (gasArray < gasNamed) {
            console.log("Array SAVES:", gasNamed - gasArray, "gas");
            console.log("Percentage saved:", ((gasNamed - gasArray) * 100) / gasNamed, "%");
        } else {
            console.log("Array COSTS MORE:", gasArray - gasNamed, "gas");
            console.log("Percentage overhead:", ((gasArray - gasNamed) * 100) / gasNamed, "%");
        }

        // Verify both escrows were created
        assertTrue(address(escrowNamed) != address(0), "Named escrow created");
        assertTrue(address(escrowArray) != address(0), "Array escrow created");
    }

    function test_GasComparison_Initialize() public {
        console.log("\n=== GAS COMPARISON: INITIALIZE ===");

        // Deploy implementations (but don't initialize yet)
        UnicitySwapEscrowImplementation escrowNamed = new UnicitySwapEscrowImplementation();
        UnicitySwapEscrowImplementationArray escrowArray = new UnicitySwapEscrowImplementationArray();

        // Measure initialization gas - Named storage
        uint256 gasBefore = gasleft();
        escrowNamed.initialize(alice, bob, address(token), 1000e18, 3e18);
        uint256 gasNamed = gasBefore - gasleft();

        // Measure initialization gas - Array storage
        gasBefore = gasleft();
        escrowArray.initialize(alice, bob, address(token), 1000e18, 3e18);
        uint256 gasArray = gasBefore - gasleft();

        // Report results
        console.log("Named storage initialize:", gasNamed);
        console.log("Array storage initialize:", gasArray);

        if (gasArray < gasNamed) {
            console.log("Array SAVES:", gasNamed - gasArray, "gas");
            console.log("Percentage saved:", ((gasNamed - gasArray) * 100) / gasNamed, "%");
        } else {
            console.log("Array COSTS MORE:", gasArray - gasNamed, "gas");
            console.log("Percentage overhead:", ((gasArray - gasNamed) * 100) / gasNamed, "%");
        }
    }

    function test_GasComparison_Swap_ERC20() public {
        console.log("\n=== GAS COMPARISON: SWAP (ERC20) ===");

        // Create both escrows
        UnicitySwapEscrowImplementation escrowNamed = deployNamedStorageEscrow();
        UnicitySwapEscrowImplementationArray escrowArray = deployArrayStorageEscrow();

        // Fund both escrows
        vm.startPrank(alice);
        token.transfer(address(escrowNamed), 1003e18);
        token.transfer(address(escrowArray), 1003e18);
        vm.stopPrank();

        // Execute swap - Named storage
        vm.prank(operator);
        uint256 gasBefore = gasleft();
        escrowNamed.swap();
        uint256 gasNamed = gasBefore - gasleft();

        // Execute swap - Array storage
        vm.prank(operator);
        gasBefore = gasleft();
        escrowArray.swap();
        uint256 gasArray = gasBefore - gasleft();

        // Report results
        console.log("Named storage swap:", gasNamed);
        console.log("Array storage swap:", gasArray);

        if (gasArray < gasNamed) {
            console.log("Array SAVES:", gasNamed - gasArray, "gas");
            console.log("Percentage saved:", ((gasNamed - gasArray) * 100) / gasNamed, "%");
        } else {
            console.log("Array COSTS MORE:", gasArray - gasNamed, "gas");
            console.log("Percentage overhead:", ((gasArray - gasNamed) * 100) / gasNamed, "%");
        }
    }

    function test_GasComparison_Swap_Native() public {
        console.log("\n=== GAS COMPARISON: SWAP (Native ETH) ===");

        // Deploy implementations
        UnicitySwapEscrowImplementation escrowNamed = new UnicitySwapEscrowImplementation();
        escrowNamed.initialize(alice, bob, address(0), 1 ether, 0.003 ether);

        UnicitySwapEscrowImplementationArray escrowArray = new UnicitySwapEscrowImplementationArray();
        escrowArray.initialize(alice, bob, address(0), 1 ether, 0.003 ether);

        // Fund both escrows
        vm.deal(address(escrowNamed), 1.003 ether);
        vm.deal(address(escrowArray), 1.003 ether);

        // Execute swap - Named storage
        vm.prank(operator);
        uint256 gasBefore = gasleft();
        escrowNamed.swap();
        uint256 gasNamed = gasBefore - gasleft();

        // Execute swap - Array storage
        vm.prank(operator);
        gasBefore = gasleft();
        escrowArray.swap();
        uint256 gasArray = gasBefore - gasleft();

        // Report results
        console.log("Named storage swap (native):", gasNamed);
        console.log("Array storage swap (native):", gasArray);

        if (gasArray < gasNamed) {
            console.log("Array SAVES:", gasNamed - gasArray, "gas");
            console.log("Percentage saved:", ((gasNamed - gasArray) * 100) / gasNamed, "%");
        } else {
            console.log("Array COSTS MORE:", gasArray - gasNamed, "gas");
            console.log("Percentage overhead:", ((gasArray - gasNamed) * 100) / gasNamed, "%");
        }
    }

    function test_GasComparison_Revert() public {
        console.log("\n=== GAS COMPARISON: REVERT ===");

        // Create both escrows
        UnicitySwapEscrowImplementation escrowNamed = deployNamedStorageEscrow();
        UnicitySwapEscrowImplementationArray escrowArray = deployArrayStorageEscrow();

        // Fund both escrows
        vm.startPrank(alice);
        token.transfer(address(escrowNamed), 1003e18);
        token.transfer(address(escrowArray), 1003e18);
        vm.stopPrank();

        // Execute revert - Named storage
        vm.prank(operator);
        uint256 gasBefore = gasleft();
        escrowNamed.revertEscrow();
        uint256 gasNamed = gasBefore - gasleft();

        // Execute revert - Array storage
        vm.prank(operator);
        gasBefore = gasleft();
        escrowArray.revertEscrow();
        uint256 gasArray = gasBefore - gasleft();

        // Report results
        console.log("Named storage revert:", gasNamed);
        console.log("Array storage revert:", gasArray);

        if (gasArray < gasNamed) {
            console.log("Array SAVES:", gasNamed - gasArray, "gas");
            console.log("Percentage saved:", ((gasNamed - gasArray) * 100) / gasNamed, "%");
        } else {
            console.log("Array COSTS MORE:", gasArray - gasNamed, "gas");
            console.log("Percentage overhead:", ((gasArray - gasNamed) * 100) / gasNamed, "%");
        }
    }

    function test_GasComparison_ViewFunctions() public {
        console.log("\n=== GAS COMPARISON: VIEW FUNCTIONS ===");

        // Create both escrows
        UnicitySwapEscrowImplementation escrowNamed = deployNamedStorageEscrow();
        UnicitySwapEscrowImplementationArray escrowArray = deployArrayStorageEscrow();

        // Test payback() getter
        uint256 gasBefore = gasleft();
        escrowNamed.payback();
        uint256 gasNamed = gasBefore - gasleft();

        gasBefore = gasleft();
        escrowArray.payback();
        uint256 gasArray = gasBefore - gasleft();

        console.log("Named storage payback():", gasNamed);
        console.log("Array storage payback():", gasArray);
        if (gasArray > gasNamed) {
            console.log("Array overhead:", gasArray - gasNamed, "gas");
        }

        // Test swapValue() getter
        gasBefore = gasleft();
        escrowNamed.swapValue();
        gasNamed = gasBefore - gasleft();

        gasBefore = gasleft();
        escrowArray.swapValue();
        gasArray = gasBefore - gasleft();

        console.log("Named storage swapValue():", gasNamed);
        console.log("Array storage swapValue():", gasArray);
        if (gasArray > gasNamed) {
            console.log("Array overhead:", gasArray - gasNamed, "gas");
        }

        // Test canSwap() getter
        gasBefore = gasleft();
        escrowNamed.canSwap();
        gasNamed = gasBefore - gasleft();

        gasBefore = gasleft();
        escrowArray.canSwap();
        gasArray = gasBefore - gasleft();

        console.log("Named storage canSwap():", gasNamed);
        console.log("Array storage canSwap():", gasArray);
        if (gasArray > gasNamed) {
            console.log("Array overhead:", gasArray - gasNamed, "gas");
        }
    }

    function test_GasComparison_FullLifecycle() public {
        console.log("\n=== GAS COMPARISON: FULL LIFECYCLE ===");

        uint256 gasNamed;
        uint256 gasArray;

        // === NAMED STORAGE LIFECYCLE ===
        {
            uint256 gasBefore = gasleft();

            // 1. Deploy escrow
            UnicitySwapEscrowImplementation escrow = deployNamedStorageEscrow();

            // 2. Fund escrow
            vm.prank(alice);
            token.transfer(address(escrow), 1003e18);

            // 3. Execute swap
            vm.prank(operator);
            escrow.swap();

            gasNamed = gasBefore - gasleft();
        }

        // === ARRAY STORAGE LIFECYCLE ===
        {
            uint256 gasBefore = gasleft();

            // 1. Deploy escrow
            UnicitySwapEscrowImplementationArray escrow = deployArrayStorageEscrow();

            // 2. Fund escrow
            vm.prank(alice);
            token.transfer(address(escrow), 1003e18);

            // 3. Execute swap
            vm.prank(operator);
            escrow.swap();

            gasArray = gasBefore - gasleft();
        }

        // Report results
        console.log("Named storage TOTAL:", gasNamed);
        console.log("Array storage TOTAL:", gasArray);

        if (gasArray < gasNamed) {
            console.log("Array SAVES:", gasNamed - gasArray, "gas");
            console.log("Percentage saved:", ((gasNamed - gasArray) * 100) / gasNamed, "%");
        } else {
            console.log("Array COSTS MORE:", gasArray - gasNamed, "gas");
            console.log("Percentage overhead:", ((gasArray - gasNamed) * 100) / gasNamed, "%");
        }
    }

    /*//////////////////////////////////////////////////////////////
                        FUNCTIONALITY VERIFICATION
    //////////////////////////////////////////////////////////////*/

    function test_ArrayImplementation_BasicFunctionality() public {
        // Create escrow
        UnicitySwapEscrowImplementationArray escrow = deployArrayStorageEscrow();

        // Verify initialization
        assertEq(escrow.payback(), alice, "Payback address");
        assertEq(escrow.recipient(), bob, "Recipient address");
        assertEq(escrow.currency(), address(token), "Currency address");
        assertEq(escrow.swapValue(), 1000e18, "Swap value");
        assertEq(escrow.feeValue(), 3e18, "Fee value");
        assertTrue(escrow.state() == UnicitySwapEscrowImplementationArray.State.COLLECTION, "Initial state");
        assertFalse(escrow.isSwapExecuted(), "Not executed");

        // Fund escrow
        vm.prank(alice);
        token.transfer(address(escrow), 1003e18);

        // Verify balance check
        assertTrue(escrow.canSwap(), "Can swap");
        assertEq(escrow.getBalance(), 1003e18, "Balance");

        // Execute swap
        vm.prank(operator);
        escrow.swap();

        // Verify final state
        assertTrue(escrow.state() == UnicitySwapEscrowImplementationArray.State.COMPLETED, "Completed state");
        assertTrue(escrow.isSwapExecuted(), "Swap executed");
        assertEq(token.balanceOf(bob), 1000e18, "Bob received swap value");
    }

    function test_ArrayImplementation_Revert() public {
        // Create escrow
        UnicitySwapEscrowImplementationArray escrow = deployArrayStorageEscrow();

        // Fund escrow
        vm.prank(alice);
        token.transfer(address(escrow), 1003e18);

        // Revert escrow
        vm.prank(operator);
        escrow.revertEscrow();

        // Verify state
        assertTrue(escrow.state() == UnicitySwapEscrowImplementationArray.State.REVERTED, "Reverted state");
        // Alice gets back 1000e18 (original 1000000e18 - 1003e18 sent + 1003e18 - 3e18 fee)
        assertEq(token.balanceOf(alice), 1000000e18 - 3e18, "Alice refunded (minus fee)");
    }

    function test_ArrayImplementation_NativeCurrency() public {
        // Deploy implementation
        UnicitySwapEscrowImplementationArray escrow = new UnicitySwapEscrowImplementationArray();
        escrow.initialize(alice, bob, address(0), 1 ether, 0.003 ether);

        // Fund escrow
        vm.deal(address(escrow), 1.003 ether);

        // Execute swap
        vm.prank(operator);
        escrow.swap();

        // Verify
        assertTrue(escrow.state() == UnicitySwapEscrowImplementationArray.State.COMPLETED, "Completed");
        assertEq(bob.balance, 101 ether, "Bob received 1 ETH (100 initial + 1 swap)");
    }
}
