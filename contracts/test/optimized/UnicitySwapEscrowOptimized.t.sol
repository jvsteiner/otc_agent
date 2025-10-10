// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../src/optimized/UnicitySwapEscrowImplementation.sol";
import "../../src/optimized/UnicitySwapEscrowProxy.sol";
import "../../src/optimized/UnicitySwapEscrowFactoryOptimized.sol";
import "../../src/UnicitySwapEscrowBeacon.sol";
import "../../src/mocks/MockERC20.sol";

/**
 * @title UnicitySwapEscrowOptimizedTest
 * @notice Comprehensive test suite for optimized beacon-proxy escrow implementation
 * @dev Tests functional parity with original + proxy-specific behaviors + gas measurements
 */
contract UnicitySwapEscrowOptimizedTest is Test {
    // Contracts
    UnicitySwapEscrowImplementation public implementation;
    UnicitySwapEscrowBeacon public beacon;
    UnicitySwapEscrowFactoryOptimized public factory;
    MockERC20 public token;

    // Test addresses
    address public operator = 0x0000000000000000000000000000000000000001; // Must match ESCROW_OPERATOR
    address payable public payback = payable(address(0x2));
    address payable public recipient = payable(address(0x3));
    address payable public feeRecipient = payable(0x0000000000000000000000000000000000000002); // Must match FEE_RECIPIENT
    address payable public gasTank = payable(0x0000000000000000000000000000000000000003); // Must match GAS_TANK

    // Test values
    uint256 public constant SWAP_VALUE = 1000 ether;
    uint256 public constant FEE_VALUE = 3 ether; // 0.3% of 1000 = 3

    // Events
    event StateTransition(UnicitySwapEscrowImplementation.State indexed from, UnicitySwapEscrowImplementation.State indexed to);
    event SwapExecuted(address indexed recipient, uint256 swapValue, uint256 feeValue);
    event Reverted(address indexed payback, uint256 amount);
    event Refunded(address indexed payback, uint256 amount);
    event Swept(address indexed currency, address indexed gasTank, uint256 amount);
    event EscrowCreated(
        address indexed escrow,
        bytes32 indexed dealID,
        address indexed operator,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    );

    function setUp() public {
        // Deploy token
        token = new MockERC20("Test Token", "TEST", 18);

        // Deploy implementation
        implementation = new UnicitySwapEscrowImplementation();

        // Deploy beacon
        beacon = new UnicitySwapEscrowBeacon(address(implementation), address(this));

        // Deploy factory
        factory = new UnicitySwapEscrowFactoryOptimized(address(beacon));

        // Fund operator, feeRecipient, and gasTank with ETH
        vm.deal(operator, 100 ether);
        vm.deal(feeRecipient, 100 ether);
        vm.deal(gasTank, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        DEPLOYMENT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Deployment_Success() public view {
        assertTrue(address(implementation) != address(0));
        assertTrue(address(beacon) != address(0));
        assertTrue(address(factory) != address(0));
        assertEq(beacon.implementation(), address(implementation));
        assertEq(factory.beacon(), address(beacon));
    }

    function test_Factory_CreateEscrow_Success() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Verify deployment
        assertTrue(escrowAddress != address(0));
        assertTrue(escrowAddress.code.length > 0);

        // Cast to implementation interface
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Verify initialization
        assertEq(escrow.payback(), payback);
        assertEq(escrow.recipient(), recipient);
        assertEq(escrow.currency(), address(token));
        assertEq(escrow.swapValue(), SWAP_VALUE);
        assertEq(escrow.feeValue(), FEE_VALUE);
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementation.State.COLLECTION));
        assertFalse(escrow.isSwapExecuted());
    }

    function test_Factory_CreateMultipleEscrows() public {
        // Create multiple escrows
        address escrow1 = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        address escrow2 = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE * 2,
            FEE_VALUE * 2
        );

        address escrow3 = factory.createEscrow(
            payback,
            recipient,
            address(0), // Native currency
            SWAP_VALUE,
            FEE_VALUE
        );

        // Verify all are different
        assertTrue(escrow1 != escrow2);
        assertTrue(escrow2 != escrow3);
        assertTrue(escrow1 != escrow3);

        // Verify parameters are independent
        UnicitySwapEscrowImplementation e1 = UnicitySwapEscrowImplementation(payable(escrow1));
        UnicitySwapEscrowImplementation e2 = UnicitySwapEscrowImplementation(payable(escrow2));
        UnicitySwapEscrowImplementation e3 = UnicitySwapEscrowImplementation(payable(escrow3));

        assertEq(e1.swapValue(), SWAP_VALUE);
        assertEq(e2.swapValue(), SWAP_VALUE * 2);
        assertEq(e3.swapValue(), SWAP_VALUE);

        assertEq(e1.currency(), address(token));
        assertEq(e2.currency(), address(token));
        assertEq(e3.currency(), address(0));
    }

    /*//////////////////////////////////////////////////////////////
                        FUNCTIONAL TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Swap_Success() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Fund escrow
        uint256 totalRequired = SWAP_VALUE + FEE_VALUE;
        token.mint(escrowAddress, totalRequired);

        // Execute swap
        vm.prank(operator);
        escrow.swap();

        // Verify state
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementation.State.COMPLETED));
        assertTrue(escrow.isSwapExecuted());

        // Verify transfers
        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(escrowAddress), 0);
    }

    function test_Swap_WithSurplus() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Fund escrow with surplus
        uint256 totalRequired = SWAP_VALUE + FEE_VALUE;
        uint256 surplus = 50 ether;
        token.mint(escrowAddress, totalRequired + surplus);

        // Execute swap
        vm.prank(operator);
        escrow.swap();

        // Verify surplus went to payback
        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(payback), surplus);
        assertEq(token.balanceOf(escrowAddress), 0);
    }

    function test_Swap_RevertsOnInsufficientBalance() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Fund with insufficient amount
        token.mint(escrowAddress, SWAP_VALUE); // Missing fee

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementation.InsufficientBalance.selector,
                SWAP_VALUE + FEE_VALUE,
                SWAP_VALUE
            )
        );
        escrow.swap();
    }

    function test_Swap_RevertsOnUnauthorized() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        token.mint(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(address(0x999));
        vm.expectRevert(UnicitySwapEscrowImplementation.UnauthorizedOperator.selector);
        escrow.swap();
    }

    function test_RevertEscrow_Success() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Fund escrow
        uint256 amount = SWAP_VALUE + FEE_VALUE + 100 ether;
        token.mint(escrowAddress, amount);

        // Execute revert
        vm.prank(operator);
        escrow.revertEscrow();

        // Verify state
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementation.State.REVERTED));
        assertFalse(escrow.isSwapExecuted());

        // Verify transfers (fees paid, rest refunded)
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(payback), amount - FEE_VALUE);
        assertEq(token.balanceOf(escrowAddress), 0);
    }

    function test_Refund_AfterSwap() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Complete swap
        token.mint(escrowAddress, SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Add more funds after swap
        uint256 additionalFunds = 200 ether;
        token.mint(escrowAddress, additionalFunds);

        // Refund
        uint256 paybackBefore = token.balanceOf(payback);
        escrow.refund();

        assertEq(token.balanceOf(payback), paybackBefore + additionalFunds);
        assertEq(token.balanceOf(escrowAddress), 0);
    }

    function test_Sweep_Success() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Complete swap
        token.mint(escrowAddress, SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Add different token
        MockERC20 otherToken = new MockERC20("Other", "OTH", 18);
        uint256 sweepAmount = 1000 ether;
        otherToken.mint(escrowAddress, sweepAmount);

        // Sweep
        escrow.sweep(address(otherToken));

        assertEq(otherToken.balanceOf(gasTank), sweepAmount);
        assertEq(otherToken.balanceOf(escrowAddress), 0);
    }

    function test_Sweep_NativeETH() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Complete swap first
        token.mint(escrowAddress, SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Send native ETH
        uint256 ethAmount = 5 ether;
        vm.deal(escrowAddress, ethAmount);

        // Sweep native
        uint256 gasTankBefore = gasTank.balance;
        escrow.sweep(address(0));

        assertEq(gasTank.balance, gasTankBefore + ethAmount);
        assertEq(escrowAddress.balance, 0);
    }

    function test_NativeSwap_Success() public {
        // Create escrow for native currency
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0), // Native currency
            SWAP_VALUE,
            FEE_VALUE
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Fund with native ETH
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        // Execute swap
        uint256 recipientBefore = recipient.balance;
        uint256 feeBefore = feeRecipient.balance;

        vm.prank(operator);
        escrow.swap();

        assertEq(recipient.balance, recipientBefore + SWAP_VALUE);
        assertEq(feeRecipient.balance, feeBefore + FEE_VALUE);
        assertEq(escrowAddress.balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                        PROXY-SPECIFIC TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Proxy_CannotInitializeTwice() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Try to initialize again
        vm.expectRevert(UnicitySwapEscrowImplementation.AlreadyInitialized.selector);
        UnicitySwapEscrowImplementation(payable(escrowAddress)).initialize(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    function test_Proxy_DealIDIsUnique() public {
        // Create multiple escrows
        address escrow1 = factory.createEscrow(payback, recipient, address(token), SWAP_VALUE, FEE_VALUE);
        address escrow2 = factory.createEscrow(payback, recipient, address(token), SWAP_VALUE, FEE_VALUE);

        bytes32 dealID1 = UnicitySwapEscrowImplementation(payable(escrow1)).dealID();
        bytes32 dealID2 = UnicitySwapEscrowImplementation(payable(escrow2)).dealID();

        // Deal IDs should be different
        assertTrue(dealID1 != dealID2);
    }

    function test_Proxy_FeeValueCalculation() public {
        // Test various swap values
        uint256[] memory swapValues = new uint256[](5);
        swapValues[0] = 1000 ether;
        swapValues[1] = 5000 ether;
        swapValues[2] = 10000 ether;
        swapValues[3] = 100 ether;
        swapValues[4] = 1 ether;

        for (uint256 i = 0; i < swapValues.length; i++) {
            uint256 feeVal = (swapValues[i] * 30) / 10000;
            address escrowAddress = factory.createEscrow(
                payback,
                recipient,
                address(token),
                swapValues[i],
                feeVal
            );
            UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

            uint256 expectedFee = (swapValues[i] * 30) / 10000;
            assertEq(escrow.feeValue(), expectedFee);
        }
    }

    function test_Beacon_UpgradeWorks() public {
        // Create escrow with current implementation
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Verify current implementation
        assertEq(beacon.implementation(), address(implementation));

        // Deploy new implementation (for testing - same contract)
        UnicitySwapEscrowImplementation newImplementation = new UnicitySwapEscrowImplementation();

        // Upgrade beacon
        beacon.upgradeTo(address(newImplementation));

        // Verify upgrade
        assertEq(beacon.implementation(), address(newImplementation));

        // Existing escrow should still work (data preserved)
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));
        assertEq(escrow.payback(), payback);
        assertEq(escrow.swapValue(), SWAP_VALUE);
    }

    /*//////////////////////////////////////////////////////////////
                        CREATE2 TESTS
    //////////////////////////////////////////////////////////////*/

    function test_CreateEscrow2_DeterministicAddress() public {
        bytes32 salt = keccak256("MY_SALT");

        // Compute expected address
        address predicted = factory.computeEscrowAddress(salt);

        // Deploy with CREATE2
        address actual = factory.createEscrow2(
            salt,
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Verify addresses match
        assertEq(actual, predicted);
    }

    function test_CreateEscrow2_DifferentSaltsDifferentAddresses() public {
        bytes32 salt1 = keccak256("SALT_1");
        bytes32 salt2 = keccak256("SALT_2");

        address escrow1 = factory.createEscrow2(
            salt1,
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        address escrow2 = factory.createEscrow2(
            salt2,
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        assertTrue(escrow1 != escrow2);
    }

    /*//////////////////////////////////////////////////////////////
                        GAS MEASUREMENT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Gas_ProxyDeployment() public {
        uint256 gasBefore = gasleft();

        factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Gas used for proxy deployment + initialization", gasUsed);

        // Verify gas usage is under 150k
        assertTrue(gasUsed < 150000, "Gas usage should be under 150k");
    }

    function test_Gas_CompareMultipleDeployments() public {
        uint256 totalGas = 0;
        uint256 numDeployments = 10;

        for (uint256 i = 0; i < numDeployments; i++) {
            uint256 gasBefore = gasleft();

            factory.createEscrow(
                payback,
                recipient,
                address(token),
                SWAP_VALUE + i,
                FEE_VALUE
            );

            uint256 gasUsed = gasBefore - gasleft();
            totalGas += gasUsed;
        }

        uint256 avgGas = totalGas / numDeployments;

        emit log_named_uint("Average gas per deployment (10 deployments)", avgGas);
        emit log_named_uint("Total gas for 10 deployments", totalGas);

        // Verify average is under 150k
        assertTrue(avgGas < 150000, "Average gas should be under 150k");
    }

    function test_Gas_CREATE2Deployment() public {
        bytes32 salt = keccak256("GAS_TEST_SALT");

        uint256 gasBefore = gasleft();

        factory.createEscrow2(
            salt,
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Gas used for CREATE2 deployment + initialization", gasUsed);

        // CREATE2 may be slightly more expensive, but should still be under 160k
        assertTrue(gasUsed < 160000, "CREATE2 gas usage should be under 160k");
    }

    /*//////////////////////////////////////////////////////////////
                        FUZZ TESTING
    //////////////////////////////////////////////////////////////*/

    function testFuzz_Swap_VariousAmounts(uint256 swapAmount, uint256 surplus) public {
        // Bound inputs
        swapAmount = bound(swapAmount, 1 ether, 1_000_000 ether);
        surplus = bound(surplus, 0, 100_000 ether);

        // Calculate fee
        uint256 feeAmount = (swapAmount * 30) / 10000;

        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            swapAmount,
            feeAmount
        );
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));

        // Fund escrow
        uint256 totalAmount = swapAmount + feeAmount + surplus;
        token.mint(escrowAddress, totalAmount);

        // Execute swap
        vm.prank(operator);
        escrow.swap();

        // Verify balances
        assertEq(token.balanceOf(recipient), swapAmount);
        assertEq(token.balanceOf(feeRecipient), feeAmount);
        assertEq(token.balanceOf(payback), surplus);
        assertEq(token.balanceOf(escrowAddress), 0);
    }
}
