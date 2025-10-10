// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/UnicitySwapEscrow.sol";
import "../src/mocks/MockERC20.sol";

/**
 * @title UnicitySwapEscrowTest
 * @notice Comprehensive test suite for UnicitySwapEscrow contract
 */
contract UnicitySwapEscrowTest is Test {
    UnicitySwapEscrow public escrow;
    MockERC20 public token;

    address public operator = address(0x1);
    address payable public payback = payable(address(0x2));
    address payable public recipient = payable(address(0x3));
    address payable public feeRecipient = payable(address(0x4));
    address payable public gasTank = payable(address(0x5));

    bytes32 public constant DEAL_ID = keccak256("TEST_DEAL_001");
    uint256 public constant SWAP_VALUE = 1000 ether;
    uint256 public constant FEE_VALUE = 10 ether;

    event StateTransition(UnicitySwapEscrow.State indexed from, UnicitySwapEscrow.State indexed to);
    event SwapExecuted(address indexed recipient, uint256 swapValue, uint256 feeValue);
    event Reverted(address indexed payback, uint256 amount);
    event Refunded(address indexed payback, uint256 amount);
    event Swept(address indexed currency, address indexed gasTank, uint256 amount);

    function setUp() public {
        token = new MockERC20("Test Token", "TEST", 18);

        escrow = new UnicitySwapEscrow(
            operator,
            DEAL_ID,
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    /*//////////////////////////////////////////////////////////////
                        CONSTRUCTOR TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_Success() public view {
        assertEq(escrow.escrowOperator(), operator);
        assertEq(escrow.dealID(), DEAL_ID);
        assertEq(escrow.payback(), payback);
        assertEq(escrow.recipient(), recipient);
        assertEq(escrow.feeRecipient(), feeRecipient);
        assertEq(escrow.gasTank(), gasTank);
        assertEq(escrow.currency(), address(token));
        assertEq(escrow.swapValue(), SWAP_VALUE);
        assertEq(escrow.feeValue(), FEE_VALUE);
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.COLLECTION));
        assertFalse(escrow.isSwapExecuted());
    }

    function test_Constructor_RevertsOnDuplicateDealID() public {
        // First escrow created successfully in setUp()

        // Attempt to create another with same dealID
        vm.expectRevert(
            abi.encodeWithSelector(UnicitySwapEscrow.DealAlreadyExists.selector, DEAL_ID)
        );
        new UnicitySwapEscrow(
            operator,
            DEAL_ID,
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    function test_Constructor_RevertsOnInvalidOperator() public {
        vm.expectRevert(
            abi.encodeWithSelector(UnicitySwapEscrow.InvalidAddress.selector, "escrowOperator")
        );
        new UnicitySwapEscrow(
            address(0),
            keccak256("UNIQUE_001"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    function test_Constructor_RevertsOnInvalidPayback() public {
        vm.expectRevert(
            abi.encodeWithSelector(UnicitySwapEscrow.InvalidAddress.selector, "payback")
        );
        new UnicitySwapEscrow(
            operator,
            keccak256("UNIQUE_002"),
            payable(address(0)),
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    /*//////////////////////////////////////////////////////////////
                        SWAP FUNCTION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Swap_Success() public {
        // Fund escrow
        uint256 totalRequired = SWAP_VALUE + FEE_VALUE;
        token.mint(address(escrow), totalRequired);

        // Execute swap
        vm.prank(operator);
        vm.expectEmit(true, true, false, true);
        emit SwapExecuted(recipient, SWAP_VALUE, FEE_VALUE);
        escrow.swap();

        // Verify state
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.COMPLETED));
        assertTrue(escrow.isSwapExecuted());

        // Verify transfers
        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Swap_WithSurplus() public {
        // Fund escrow with surplus
        uint256 totalRequired = SWAP_VALUE + FEE_VALUE;
        uint256 surplus = 50 ether;
        token.mint(address(escrow), totalRequired + surplus);

        // Execute swap
        vm.prank(operator);
        escrow.swap();

        // Verify surplus went to payback
        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(payback), surplus);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Swap_RevertsOnUnauthorized() public {
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);

        vm.prank(address(0x999));
        vm.expectRevert(UnicitySwapEscrow.UnauthorizedOperator.selector);
        escrow.swap();
    }

    function test_Swap_RevertsOnInsufficientBalance() public {
        // Fund with insufficient amount
        token.mint(address(escrow), SWAP_VALUE); // Missing fee

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrow.InsufficientBalance.selector,
                SWAP_VALUE + FEE_VALUE,
                SWAP_VALUE
            )
        );
        escrow.swap();
    }

    function test_Swap_RevertsOnDoubleSwap() public {
        // Fund escrow
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);

        // First swap succeeds
        vm.startPrank(operator);
        escrow.swap();

        // Fund again for second attempt
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);

        // Second swap should fail (already executed)
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrow.InvalidState.selector,
                UnicitySwapEscrow.State.COMPLETED,
                UnicitySwapEscrow.State.COLLECTION
            )
        );
        escrow.swap();
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        REVERT FUNCTION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Revert_Success() public {
        // Fund escrow
        uint256 amount = SWAP_VALUE + FEE_VALUE + 100 ether;
        token.mint(address(escrow), amount);

        // Execute revert
        vm.prank(operator);
        vm.expectEmit(true, false, false, false);
        emit Reverted(payback, 0); // Balance will be 0 after refund
        escrow.revertEscrow();

        // Verify state
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.REVERTED));
        assertFalse(escrow.isSwapExecuted());

        // Verify transfers (fees paid, rest refunded)
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(payback), amount - FEE_VALUE);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Revert_RevertsOnUnauthorized() public {
        vm.prank(address(0x999));
        vm.expectRevert(UnicitySwapEscrow.UnauthorizedOperator.selector);
        escrow.revertEscrow();
    }

    function test_Revert_RevertsAfterSwap() public {
        // Execute swap first
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Attempt revert
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrow.InvalidState.selector,
                UnicitySwapEscrow.State.COMPLETED,
                UnicitySwapEscrow.State.COLLECTION
            )
        );
        escrow.revertEscrow();
    }

    /*//////////////////////////////////////////////////////////////
                        REFUND FUNCTION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Refund_AfterSwap() public {
        // Complete swap
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Add more funds after swap
        uint256 additionalFunds = 200 ether;
        token.mint(address(escrow), additionalFunds);

        // Refund
        uint256 paybackBefore = token.balanceOf(payback);
        escrow.refund();

        assertEq(token.balanceOf(payback), paybackBefore + additionalFunds);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Refund_AfterRevert() public {
        // Execute revert
        uint256 amount = 500 ether;
        token.mint(address(escrow), amount);
        vm.prank(operator);
        escrow.revertEscrow();

        // Add more funds after revert
        uint256 additionalFunds = 100 ether;
        token.mint(address(escrow), additionalFunds);

        // Refund again
        uint256 paybackBefore = token.balanceOf(payback);
        escrow.refund();

        assertEq(token.balanceOf(payback), paybackBefore + additionalFunds);
    }

    function test_Refund_RevertsInCollectionState() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrow.InvalidStateMultiple.selector,
                UnicitySwapEscrow.State.COLLECTION,
                UnicitySwapEscrow.State.COMPLETED,
                UnicitySwapEscrow.State.REVERTED
            )
        );
        escrow.refund();
    }

    /*//////////////////////////////////////////////////////////////
                        SWEEP FUNCTION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Sweep_AfterCompletion() public {
        // Complete swap
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Add different token
        MockERC20 otherToken = new MockERC20("Other", "OTH", 18);
        uint256 sweepAmount = 1000 ether;
        otherToken.mint(address(escrow), sweepAmount);

        // Sweep
        vm.expectEmit(true, true, false, true);
        emit Swept(address(otherToken), gasTank, sweepAmount);
        escrow.sweep(address(otherToken));

        assertEq(otherToken.balanceOf(gasTank), sweepAmount);
        assertEq(otherToken.balanceOf(address(escrow)), 0);
    }

    function test_Sweep_NativeETH() public {
        // Complete swap first
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Send native ETH
        uint256 ethAmount = 5 ether;
        vm.deal(address(escrow), ethAmount);

        // Sweep native
        uint256 gasTankBefore = gasTank.balance;
        escrow.sweep(address(0));

        assertEq(gasTank.balance, gasTankBefore + ethAmount);
        assertEq(address(escrow).balance, 0);
    }

    function test_Sweep_RevertsOnSwapCurrency() public {
        // Complete swap
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);
        vm.prank(operator);
        escrow.swap();

        // Attempt to sweep swap currency
        vm.expectRevert(
            abi.encodeWithSelector(UnicitySwapEscrow.InvalidCurrency.selector, address(token))
        );
        escrow.sweep(address(token));
    }

    function test_Sweep_RevertsInCollectionState() public {
        MockERC20 otherToken = new MockERC20("Other", "OTH", 18);
        otherToken.mint(address(escrow), 1000 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrow.InvalidStateMultiple.selector,
                UnicitySwapEscrow.State.COLLECTION,
                UnicitySwapEscrow.State.COMPLETED,
                UnicitySwapEscrow.State.REVERTED
            )
        );
        escrow.sweep(address(otherToken));
    }

    /*//////////////////////////////////////////////////////////////
                        VIEW FUNCTION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_CanSwap_ReturnsFalseWhenInsufficientBalance() public view {
        assertFalse(escrow.canSwap());
    }

    function test_CanSwap_ReturnsTrueWhenSufficientBalance() public {
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE);
        assertTrue(escrow.canSwap());
    }

    function test_CanSwap_ReturnsTrueWithSurplus() public {
        token.mint(address(escrow), SWAP_VALUE + FEE_VALUE + 1000 ether);
        assertTrue(escrow.canSwap());
    }

    function test_GetBalance_ReturnsCorrectBalance() public {
        uint256 amount = 12345 ether;
        token.mint(address(escrow), amount);
        assertEq(escrow.getBalance(), amount);
    }

    /*//////////////////////////////////////////////////////////////
                        NATIVE CURRENCY TESTS
    //////////////////////////////////////////////////////////////*/

    function test_NativeSwap_Success() public {
        // Create escrow for native currency
        UnicitySwapEscrow nativeEscrow = new UnicitySwapEscrow(
            operator,
            keccak256("NATIVE_DEAL"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(0), // Native currency
            SWAP_VALUE,
            FEE_VALUE
        );

        // Fund with native ETH
        vm.deal(address(nativeEscrow), SWAP_VALUE + FEE_VALUE);

        // Execute swap
        uint256 recipientBefore = recipient.balance;
        uint256 feeBefore = feeRecipient.balance;

        vm.prank(operator);
        nativeEscrow.swap();

        assertEq(recipient.balance, recipientBefore + SWAP_VALUE);
        assertEq(feeRecipient.balance, feeBefore + FEE_VALUE);
        assertEq(address(nativeEscrow).balance, 0);
    }

    function test_NativeRevert_Success() public {
        // Create escrow for native currency
        UnicitySwapEscrow nativeEscrow = new UnicitySwapEscrow(
            operator,
            keccak256("NATIVE_REVERT"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Fund with native ETH
        uint256 amount = SWAP_VALUE + FEE_VALUE + 100 ether;
        vm.deal(address(nativeEscrow), amount);

        // Execute revert
        uint256 paybackBefore = payback.balance;
        uint256 feeBefore = feeRecipient.balance;

        vm.prank(operator);
        nativeEscrow.revertEscrow();

        assertEq(feeRecipient.balance, feeBefore + FEE_VALUE);
        assertEq(payback.balance, paybackBefore + amount - FEE_VALUE);
    }

    /*//////////////////////////////////////////////////////////////
                        EDGE CASE TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ZeroSwapValue() public {
        UnicitySwapEscrow zeroEscrow = new UnicitySwapEscrow(
            operator,
            keccak256("ZERO_SWAP"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            0, // Zero swap value
            FEE_VALUE
        );

        // Fund with just fee
        token.mint(address(zeroEscrow), FEE_VALUE);

        // Should succeed
        vm.prank(operator);
        zeroEscrow.swap();

        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
    }

    function test_ZeroFeeValue() public {
        UnicitySwapEscrow zeroFeeEscrow = new UnicitySwapEscrow(
            operator,
            keccak256("ZERO_FEE"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            SWAP_VALUE,
            0 // Zero fee
        );

        // Fund with just swap value
        token.mint(address(zeroFeeEscrow), SWAP_VALUE);

        // Should succeed
        vm.prank(operator);
        zeroFeeEscrow.swap();

        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), 0);
    }

    function test_ExactBalance() public {
        // Fund with exact required amount
        uint256 exactAmount = SWAP_VALUE + FEE_VALUE;
        token.mint(address(escrow), exactAmount);

        vm.prank(operator);
        escrow.swap();

        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(payback), 0); // No surplus
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_ReceiveNativeETH() public {
        // Create native escrow
        UnicitySwapEscrow nativeEscrow = new UnicitySwapEscrow(
            operator,
            keccak256("RECEIVE_TEST"),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Send ETH via receive
        uint256 amount = 10 ether;
        (bool success, ) = address(nativeEscrow).call{value: amount}("");
        assertTrue(success);
        assertEq(address(nativeEscrow).balance, amount);
    }

    /*//////////////////////////////////////////////////////////////
                    FUZZ TESTING
    //////////////////////////////////////////////////////////////*/

    function testFuzz_Swap_WithVariousAmounts(uint256 swapAmount, uint256 feeAmount, uint256 surplus) public {
        // Bound inputs to reasonable ranges
        swapAmount = bound(swapAmount, 1 ether, 1_000_000 ether);
        feeAmount = bound(feeAmount, 0, 10_000 ether);
        surplus = bound(surplus, 0, 100_000 ether);

        // Create escrow with fuzzed values
        UnicitySwapEscrow fuzzEscrow = new UnicitySwapEscrow(
            operator,
            keccak256(abi.encodePacked("FUZZ", swapAmount, feeAmount)),
            payback,
            recipient,
            feeRecipient,
            gasTank,
            address(token),
            swapAmount,
            feeAmount
        );

        // Fund escrow
        uint256 totalAmount = swapAmount + feeAmount + surplus;
        token.mint(address(fuzzEscrow), totalAmount);

        // Execute swap
        vm.prank(operator);
        fuzzEscrow.swap();

        // Verify balances
        assertEq(token.balanceOf(recipient), swapAmount);
        assertEq(token.balanceOf(feeRecipient), feeAmount);
        assertEq(token.balanceOf(payback), surplus);
        assertEq(token.balanceOf(address(fuzzEscrow)), 0);
    }
}
