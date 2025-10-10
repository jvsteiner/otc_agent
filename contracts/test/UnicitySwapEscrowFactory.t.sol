// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/UnicitySwapEscrow.sol";
import "../src/UnicitySwapEscrowFactory.sol";
import "../src/mocks/MockERC20.sol";

/**
 * @title UnicitySwapEscrowFactoryTest
 * @notice Test suite for factory deployment pattern
 */
contract UnicitySwapEscrowFactoryTest is Test {
    UnicitySwapEscrowFactory public factory;
    MockERC20 public token;

    address public operator = address(0x2);
    address payable public payback = payable(address(0x3));
    address payable public recipient = payable(address(0x4));
    address payable public feeRecipient = payable(address(0x5));
    address payable public gasTank = payable(address(0x6));

    uint256 public constant SWAP_VALUE = 1000 ether;
    uint256 public constant FEE_VALUE = 10 ether;

    event EscrowCreated(
        address indexed escrow,
        bytes32 indexed dealID,
        address indexed operator,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    );

    function setUp() public {
        token = new MockERC20("Test Token", "TEST", 18);
        factory = new UnicitySwapEscrowFactory();
    }

    /*//////////////////////////////////////////////////////////////
                        FACTORY DEPLOYMENT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Factory_Deployment() public view {
        // Factory should be deployed
        assertTrue(address(factory) != address(0));
    }

    /*//////////////////////////////////////////////////////////////
                        CREATE ESCROW TESTS
    //////////////////////////////////////////////////////////////*/

    function test_CreateEscrow_Success() public {
        bytes32 dealId = keccak256("DEAL_001");

        // Expect event
        vm.expectEmit(false, true, true, true);
        emit EscrowCreated(
            address(0), // We don't know the address yet
            dealId,
            operator,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Create escrow
        address escrowAddress = factory.createEscrow(
            operator,
            dealId,
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Verify escrow is deployed
        assertTrue(escrowAddress != address(0));
        assertTrue(escrowAddress.code.length > 0);

        // Cast to escrow and verify parameters
        UnicitySwapEscrow escrow = UnicitySwapEscrow(payable(escrowAddress));

        assertEq(escrow.escrowOperator(), operator);
        assertEq(escrow.dealID(), dealId);
        assertEq(escrow.payback(), payback);
        assertEq(escrow.recipient(), recipient);
        assertEq(escrow.feeRecipient(), feeRecipient);
        assertEq(escrow.gasTank(), gasTank);
        assertEq(escrow.currency(), address(token));
        assertEq(escrow.swapValue(), SWAP_VALUE);
        assertEq(escrow.feeValue(), FEE_VALUE);
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.COLLECTION));
    }

    function test_CreateEscrow_MultipleInstances() public {
        // Create multiple escrows
        address escrow1 = factory.createEscrow(
            operator,
            keccak256("DEAL_001"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        address escrow2 = factory.createEscrow(
            operator,
            keccak256("DEAL_002"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE * 2,
            FEE_VALUE * 2
        );

        address escrow3 = factory.createEscrow(
            operator,
            keccak256("DEAL_003"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(0), // Native currency
            SWAP_VALUE,
            FEE_VALUE
        );

        // Verify all are different
        assertTrue(escrow1 != escrow2);
        assertTrue(escrow2 != escrow3);
        assertTrue(escrow1 != escrow3);

        // Verify parameters are independent
        UnicitySwapEscrow e1 = UnicitySwapEscrow(payable(escrow1));
        UnicitySwapEscrow e2 = UnicitySwapEscrow(payable(escrow2));
        UnicitySwapEscrow e3 = UnicitySwapEscrow(payable(escrow3));

        assertEq(e1.swapValue(), SWAP_VALUE);
        assertEq(e2.swapValue(), SWAP_VALUE * 2);
        assertEq(e3.swapValue(), SWAP_VALUE);

        assertEq(e1.currency(), address(token));
        assertEq(e2.currency(), address(token));
        assertEq(e3.currency(), address(0));
    }

    function test_CreateEscrow_FunctionalityWorks() public {
        // Create escrow via factory
        address escrowAddress = factory.createEscrow(
            operator,
            keccak256("FUNCTIONAL_TEST"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrow escrow = UnicitySwapEscrow(payable(escrowAddress));

        // Fund and execute swap
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE + 100 ether);

        vm.prank(operator);
        escrow.swap();

        // Verify swap executed correctly
        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(payback), 100 ether);
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.COMPLETED));
    }

    /*//////////////////////////////////////////////////////////////
                        CREATE2 TESTS
    //////////////////////////////////////////////////////////////*/

    function test_CreateEscrow2_DeterministicAddress() public {
        bytes32 salt = keccak256("MY_SALT");
        bytes32 dealId = keccak256("DEAL_CREATE2");

        // Compute expected address
        address predicted = factory.computeEscrowAddress(
            salt,
            operator,
            dealId,
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Deploy with CREATE2
        address actual = factory.createEscrow2(
            salt,
            operator,
            dealId,
            payback,
            recipient,
            feeRecipient,
            gasTank,
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
            operator,
            keccak256("DEAL_1"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        address escrow2 = factory.createEscrow2(
            salt2,
            operator,
            keccak256("DEAL_2"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        assertTrue(escrow1 != escrow2);
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON TESTS
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_DirectVsFactory() public {
        // Measure gas for direct deployment
        uint256 gasBefore = gasleft();
        new UnicitySwapEscrow(
            operator,
            keccak256("DIRECT"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        uint256 directGas = gasBefore - gasleft();

        // Measure gas for factory deployment
        gasBefore = gasleft();
        factory.createEscrow(
            operator,
            keccak256("FACTORY"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        uint256 factoryGas = gasBefore - gasleft();

        emit log_named_uint("Direct deployment gas", directGas);
        emit log_named_uint("Factory deployment gas", factoryGas);

        // Factory adds minimal overhead (just the function call)
        assertTrue(factoryGas > directGas);
        assertTrue(factoryGas < directGas + 50000); // Less than 50k gas overhead
    }
}
