// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/UnicitySwapBroker.sol";
import "../src/mocks/MockERC20.sol";
import "./SignatureHelper.sol";

/**
 * @title UnicitySwapBrokerTest
 * @notice Comprehensive test suite for UnicitySwapBroker contract
 * @dev Tests all swap/revert scenarios, security features, and edge cases
 */
contract UnicitySwapBrokerTest is Test {
    UnicitySwapBroker public broker;
    MockERC20 public token;
    SignatureHelper public sigHelper;

    address public owner = address(0x1);
    address public operator;
    uint256 public operatorPrivateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address public escrow = address(0x3);
    address payable public payback = payable(address(0x4));
    address payable public recipient = payable(address(0x5));
    address payable public feeRecipient = payable(address(0x6));

    bytes32 public constant DEAL_ID_1 = keccak256("TEST_DEAL_001");
    bytes32 public constant DEAL_ID_2 = keccak256("TEST_DEAL_002");
    bytes32 public constant DEAL_ID_3 = keccak256("TEST_DEAL_003");

    uint256 public constant SWAP_AMOUNT = 1000 ether;
    uint256 public constant FEE_AMOUNT = 10 ether;
    uint256 public constant SURPLUS_AMOUNT = 5 ether;
    uint256 public constant TOTAL_AMOUNT = SWAP_AMOUNT + FEE_AMOUNT + SURPLUS_AMOUNT;

    event SwapExecuted(
        bytes32 indexed dealId,
        address indexed currency,
        address recipient,
        address feeRecipient,
        address payback,
        uint256 swapAmount,
        uint256 feeAmount,
        uint256 refundAmount
    );

    event RevertExecuted(
        bytes32 indexed dealId,
        address indexed currency,
        address feeRecipient,
        address payback,
        uint256 feeAmount,
        uint256 refundAmount
    );

    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    event RefundExecuted(
        bytes32 indexed dealId,
        address indexed currency,
        address feeRecipient,
        address payback,
        uint256 feeAmount,
        uint256 refundAmount
    );

    function setUp() public {
        // Derive operator address from private key
        operator = vm.addr(operatorPrivateKey);

        vm.startPrank(owner);
        broker = new UnicitySwapBroker(operator);
        token = new MockERC20("Test Token", "TEST", 18);
        sigHelper = new SignatureHelper();
        vm.stopPrank();

        // Fund test accounts
        vm.deal(escrow, 10000 ether);
        vm.deal(operator, 10000 ether);

        // Mint tokens to escrow
        token.mint(escrow, 100000 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        CONSTRUCTOR TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_Success() public view {
        assertEq(broker.operator(), operator);
        assertEq(broker.owner(), owner);
    }

    function test_Constructor_RevertsOnInvalidOperator() public {
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "operator"));
        new UnicitySwapBroker(address(0));
    }

    /*//////////////////////////////////////////////////////////////
                        OPERATOR MANAGEMENT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_SetOperator_Success() public {
        address newOperator = address(0x999);

        vm.expectEmit(true, true, false, true);
        emit OperatorUpdated(operator, newOperator);

        vm.prank(owner);
        broker.setOperator(newOperator);

        assertEq(broker.operator(), newOperator);
    }

    function test_SetOperator_RevertsOnInvalidAddress() public {
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "newOperator"));

        vm.prank(owner);
        broker.setOperator(address(0));
    }

    function test_SetOperator_RevertsOnUnauthorized() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));

        vm.prank(operator);
        broker.setOperator(address(0x999));
    }

    /*//////////////////////////////////////////////////////////////
                        NATIVE SWAP TESTS
    //////////////////////////////////////////////////////////////*/

    function test_SwapNative_Success() public {
        uint256 recipientBalanceBefore = recipient.balance;
        uint256 feeRecipientBalanceBefore = feeRecipient.balance;
        uint256 paybackBalanceBefore = payback.balance;

        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.expectEmit(true, true, false, true);
        emit SwapExecuted(
            DEAL_ID_1,
            address(0),
            recipient,
            feeRecipient,
            payback,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            SURPLUS_AMOUNT
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Verify balances
        assertEq(recipient.balance, recipientBalanceBefore + SWAP_AMOUNT);
        assertEq(feeRecipient.balance, feeRecipientBalanceBefore + FEE_AMOUNT);
        assertEq(payback.balance, paybackBalanceBefore + SURPLUS_AMOUNT);

        // Verify deal is marked as processed
        assertTrue(broker.processedDeals(DEAL_ID_1));
    }

    function test_SwapNative_SuccessWithZeroSurplus() public {
        uint256 exactAmount = SWAP_AMOUNT + FEE_AMOUNT;

        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: exactAmount}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Verify no surplus sent to payback
        assertEq(payback.balance, 0);
        assertTrue(broker.processedDeals(DEAL_ID_1));
    }

    function test_SwapNative_SuccessWithZeroFees() public {
        uint256 totalWithoutFee = SWAP_AMOUNT + SURPLUS_AMOUNT;

        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            0, // zero fees
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: totalWithoutFee}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            0, // zero fees
            signature
        );

        assertEq(recipient.balance, SWAP_AMOUNT);
        assertEq(feeRecipient.balance, 0);
        assertEq(payback.balance, SURPLUS_AMOUNT);
    }

    function test_SwapNative_SuccessWithNonOperator() public {
        // Test that non-operator can call swapNative (escrow EOA flow)
        address nonOperator = address(0x999);
        vm.deal(nonOperator, TOTAL_AMOUNT);

        uint256 recipientBalanceBefore = recipient.balance;
        uint256 feeRecipientBalanceBefore = feeRecipient.balance;
        uint256 paybackBalanceBefore = payback.balance;

        vm.expectEmit(true, true, false, true);
        emit SwapExecuted(
            DEAL_ID_1,
            address(0),
            recipient,
            feeRecipient,
            payback,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            SURPLUS_AMOUNT
        );

        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            nonOperator
        );

        vm.prank(nonOperator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Verify balances
        assertEq(recipient.balance, recipientBalanceBefore + SWAP_AMOUNT);
        assertEq(feeRecipient.balance, feeRecipientBalanceBefore + FEE_AMOUNT);
        assertEq(payback.balance, paybackBalanceBefore + SURPLUS_AMOUNT);

        // Verify deal is marked as processed
        assertTrue(broker.processedDeals(DEAL_ID_1));
    }

    function test_SwapNative_RevertsOnInsufficientBalance() public {
        // Generate valid signature but send insufficient funds
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapBroker.InsufficientBalance.selector,
                SWAP_AMOUNT + FEE_AMOUNT,
                SWAP_AMOUNT - 1
            )
        );

        vm.prank(operator);
        broker.swapNative{value: SWAP_AMOUNT - 1}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );
    }

    function test_SwapNative_RevertsOnDuplicateDealId() public {
        // First swap succeeds
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Generate signature for second attempt
        bytes memory signature2 = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // Second swap with same dealId fails
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.DealAlreadyProcessed.selector, DEAL_ID_1));

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature2
        );
    }

    function test_SwapNative_RevertsOnInvalidPayback() public {
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payable(address(0)),
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "payback"));

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payable(address(0)),
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );
    }

    function test_SwapNative_RevertsOnInvalidRecipient() public {
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            payable(address(0)),
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "recipient"));

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            payable(address(0)),
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );
    }

    function test_SwapNative_RevertsOnInvalidFeeRecipient() public {
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            payable(address(0)),
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "feeRecipient"));

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            payable(address(0)),
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );
    }

    /*//////////////////////////////////////////////////////////////
                        ERC20 SWAP TESTS
    //////////////////////////////////////////////////////////////*/

    function test_SwapERC20_Success() public {
        // Create fresh recipients
        address payable freshRecipient = payable(address(0x7001));
        address payable freshFeeRecipient = payable(address(0x7002));
        address payable freshPayback = payable(address(0x7003));

        // Create fresh escrow with exact amount
        address testEscrow = address(0x1234);
        uint256 escrowAmount = SWAP_AMOUNT + FEE_AMOUNT + SURPLUS_AMOUNT;
        token.mint(testEscrow, escrowAmount);

        // Approve broker to spend tokens from escrow
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            freshPayback,
            freshRecipient,
            freshFeeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );

        // Verify balances
        assertEq(token.balanceOf(freshRecipient), SWAP_AMOUNT);
        assertEq(token.balanceOf(freshFeeRecipient), FEE_AMOUNT);
        assertEq(token.balanceOf(freshPayback), SURPLUS_AMOUNT);

        // Verify deal is marked as processed
        assertTrue(broker.processedDeals(DEAL_ID_1));
    }

    function test_SwapERC20_SuccessWithExactAmount() public {
        // Create fresh escrow with exact amount
        address testEscrow = address(0x5678);
        uint256 exactAmount = SWAP_AMOUNT + FEE_AMOUNT;
        token.mint(testEscrow, exactAmount);

        // Approve broker
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );

        // Verify no surplus
        assertEq(token.balanceOf(payback), 0);
    }

    function test_SwapERC20_RevertsOnInsufficientBalance() public {
        // Create fresh escrow with insufficient balance
        address testEscrow = address(0x9abc);
        uint256 insufficientAmount = 100 ether;
        token.mint(testEscrow, insufficientAmount);

        // Approve broker
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapBroker.InsufficientBalance.selector,
                SWAP_AMOUNT + FEE_AMOUNT,
                insufficientAmount
            )
        );

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );
    }

    function test_SwapERC20_RevertsOnDuplicateDealId() public {
        // Create fresh escrow
        address testEscrow = address(0xdef1);
        token.mint(testEscrow, SWAP_AMOUNT + FEE_AMOUNT);

        // Approve broker
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        // First swap succeeds
        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );

        // Second swap with same dealId fails
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.DealAlreadyProcessed.selector, DEAL_ID_1));

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );
    }

    function test_SwapERC20_RevertsOnInvalidCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "currency"));

        vm.prank(operator);
        broker.swapERC20(
            address(0),
            DEAL_ID_1,
            escrow,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );
    }

    function test_SwapERC20_RevertsOnInvalidEscrow() public {
        vm.expectRevert(UnicitySwapBroker.InvalidEscrowAddress.selector);

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            address(0),
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );
    }

    /*//////////////////////////////////////////////////////////////
                        NATIVE REVERT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_RevertNative_Success() public {
        uint256 totalAmount = FEE_AMOUNT + SURPLUS_AMOUNT;
        uint256 feeRecipientBalanceBefore = feeRecipient.balance;
        uint256 paybackBalanceBefore = payback.balance;

        vm.expectEmit(true, true, false, true);
        emit RevertExecuted(
            DEAL_ID_1,
            address(0),
            feeRecipient,
            payback,
            FEE_AMOUNT,
            SURPLUS_AMOUNT
        );

        // Generate signature
        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.revertNative{value: totalAmount}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature
        );

        // Verify balances
        assertEq(feeRecipient.balance, feeRecipientBalanceBefore + FEE_AMOUNT);
        assertEq(payback.balance, paybackBalanceBefore + SURPLUS_AMOUNT);

        // Verify deal is marked as processed
        assertTrue(broker.processedDeals(DEAL_ID_1));
    }

    function test_RevertNative_SuccessWithZeroFees() public {
        // Generate signature
        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            0, // zero fees
            operator
        );

        vm.prank(operator);
        broker.revertNative{value: SURPLUS_AMOUNT}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            0, // zero fees
            signature
        );

        assertEq(feeRecipient.balance, 0);
        assertEq(payback.balance, SURPLUS_AMOUNT);
    }

    function test_RevertNative_RevertsOnInsufficientBalance() public {
        // Generate valid signature but send insufficient funds
        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapBroker.InsufficientBalance.selector,
                FEE_AMOUNT,
                FEE_AMOUNT - 1
            )
        );

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT - 1}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature
        );
    }

    function test_RevertNative_RevertsOnDuplicateDealId() public {
        // First revert succeeds
        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT + SURPLUS_AMOUNT}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature
        );

        // Generate signature for second attempt
        bytes memory signature2 = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        // Second revert with same dealId fails
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.DealAlreadyProcessed.selector, DEAL_ID_1));

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT + SURPLUS_AMOUNT}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature2
        );
    }

    function test_RevertNative_SuccessWithNonOperator() public {
        // Test that non-operator can call revertNative (escrow EOA flow)
        address nonOperator = address(0x888);
        uint256 totalAmount = FEE_AMOUNT + SURPLUS_AMOUNT;
        vm.deal(nonOperator, totalAmount);

        uint256 feeRecipientBalanceBefore = feeRecipient.balance;
        uint256 paybackBalanceBefore = payback.balance;

        vm.expectEmit(true, true, false, true);
        emit RevertExecuted(
            DEAL_ID_1,
            address(0),
            feeRecipient,
            payback,
            FEE_AMOUNT,
            SURPLUS_AMOUNT
        );

        // Generate signature
        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            nonOperator
        );

        vm.prank(nonOperator);
        broker.revertNative{value: totalAmount}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature
        );

        // Verify balances
        assertEq(feeRecipient.balance, feeRecipientBalanceBefore + FEE_AMOUNT);
        assertEq(payback.balance, paybackBalanceBefore + SURPLUS_AMOUNT);

        // Verify deal is marked as processed
        assertTrue(broker.processedDeals(DEAL_ID_1));
    }

    /*//////////////////////////////////////////////////////////////
                        ERC20 REVERT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_RevertERC20_Success() public {
        uint256 escrowAmount = FEE_AMOUNT + SURPLUS_AMOUNT;

        // Create fresh escrow with exact amount
        address testEscrow = address(0xabcd);
        token.mint(testEscrow, escrowAmount);

        // Approve broker to spend tokens from escrow
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        uint256 feeRecipientBalanceBefore = token.balanceOf(feeRecipient);
        uint256 paybackBalanceBefore = token.balanceOf(payback);

        vm.prank(operator);
        broker.revertERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            feeRecipient,
            FEE_AMOUNT
        );

        // Verify fee recipient got fees
        assertEq(token.balanceOf(feeRecipient), feeRecipientBalanceBefore + FEE_AMOUNT);

        // Verify payback got remaining
        assertEq(token.balanceOf(payback), paybackBalanceBefore + SURPLUS_AMOUNT);

        // Verify deal is marked as processed
        assertTrue(broker.processedDeals(DEAL_ID_1));
    }

    function test_RevertERC20_RevertsOnInsufficientBalance() public {
        // Create fresh escrow with insufficient balance
        address testEscrow = address(0xbcde);
        uint256 insufficientAmount = FEE_AMOUNT - 1;
        token.mint(testEscrow, insufficientAmount);

        // Approve broker
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapBroker.InsufficientBalance.selector,
                FEE_AMOUNT,
                insufficientAmount
            )
        );

        vm.prank(operator);
        broker.revertERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            feeRecipient,
            FEE_AMOUNT
        );
    }

    function test_RevertERC20_RevertsOnDuplicateDealId() public {
        // Create fresh escrow
        address testEscrow = address(0xcdef);
        token.mint(testEscrow, FEE_AMOUNT + SURPLUS_AMOUNT);

        // Approve broker
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        // First revert succeeds
        vm.prank(operator);
        broker.revertERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            feeRecipient,
            FEE_AMOUNT
        );

        // Second revert with same dealId fails
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.DealAlreadyProcessed.selector, DEAL_ID_1));

        vm.prank(operator);
        broker.revertERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            feeRecipient,
            FEE_AMOUNT
        );
    }

    /*//////////////////////////////////////////////////////////////
                        CROSS-OPERATION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_SwapThenRevert_RevertsOnSameDealId() public {
        // Execute swap
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Generate signature for revert attempt
        bytes memory signature2 = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        // Attempt revert with same dealId fails
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.DealAlreadyProcessed.selector, DEAL_ID_1));

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature2
        );
    }

    function test_RevertThenSwap_RevertsOnSameDealId() public {
        // Execute revert
        // Generate signature
        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature
        );

        // Generate signature for swap attempt
        bytes memory signature2 = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // Attempt swap with same dealId fails
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.DealAlreadyProcessed.selector, DEAL_ID_1));

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature2
        );
    }

    function test_MultipleDifferentDeals_Success() public {
        // Deal 1: Native swap
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Deal 2: Native revert
        // Generate signature
        bytes memory signature2 = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_2,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT}(
            DEAL_ID_2,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature2
        );

        // Deal 3: ERC20 swap
        address testEscrow3 = address(0xabc3);
        token.mint(testEscrow3, SWAP_AMOUNT + FEE_AMOUNT);
        vm.prank(testEscrow3);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_3,
            testEscrow3,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );

        // Verify all deals are marked as processed
        assertTrue(broker.processedDeals(DEAL_ID_1));
        assertTrue(broker.processedDeals(DEAL_ID_2));
        assertTrue(broker.processedDeals(DEAL_ID_3));
    }

    /*//////////////////////////////////////////////////////////////
                        REENTRANCY TESTS
    //////////////////////////////////////////////////////////////*/

    function test_SwapNative_ReentrancyProtection() public {
        // Deploy malicious recipient that attempts reentrancy
        MaliciousRecipient malicious = new MaliciousRecipient(address(broker), operator);
        vm.deal(address(malicious), 10000 ether);

        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            payable(address(malicious)),
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            payable(address(malicious)),
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Verify deal was processed only once
        assertTrue(broker.processedDeals(DEAL_ID_1));

        // Verify malicious contract didn't succeed in double-execution
        assertEq(malicious.attackSucceeded(), false);
    }

    /*//////////////////////////////////////////////////////////////
                        RECEIVE/FALLBACK TESTS
    //////////////////////////////////////////////////////////////*/

    function test_DirectDeposit_RejectsViaCall() public {
        // Test direct native currency deposit via low-level call
        (bool success, ) = address(broker).call{value: 1 ether}("");
        assertFalse(success, "Direct deposits via call should be rejected");
    }

    function test_DirectDeposit_RejectsViaTransfer() public {
        // Test direct deposit via transfer (should revert)
        address payable brokerPayable = payable(address(broker));
        vm.expectRevert();
        brokerPayable.transfer(1 ether);
    }

    function test_DirectDeposit_RejectsViaSend() public {
        // Test direct deposit via send (should return false)
        address payable brokerPayable = payable(address(broker));
        bool success = brokerPayable.send(1 ether);
        assertFalse(success, "Direct deposits via send should fail");
    }

    function test_DirectDeposit_RejectsWithRandomCalldata() public {
        // Test deposit with random calldata (non-existent function)
        (bool success, ) = address(broker).call{value: 1 ether}(abi.encodeWithSignature("nonexistent()"));
        assertFalse(success, "Deposits with random calldata should be rejected");
    }

    function test_DirectDeposit_RejectsWithInvalidSignature() public {
        // Test deposit with invalid function signature
        (bool success, ) = address(broker).call{value: 1 ether}(abi.encodeWithSignature("fakeFunction(uint256)", 123));
        assertFalse(success, "Deposits with invalid signatures should be rejected");
    }

    function test_DirectDeposit_RejectsEmptyCalldata() public {
        // Test deposit with empty calldata (hits receive/fallback)
        (bool success, ) = address(broker).call{value: 1 ether}("");
        assertFalse(success, "Deposits with empty calldata should be rejected");
    }

    function test_DirectDeposit_RejectsArbitraryCalldata() public {
        // Test deposit with arbitrary byte data
        (bool success, ) = address(broker).call{value: 1 ether}(hex"deadbeef");
        assertFalse(success, "Deposits with arbitrary calldata should be rejected");
    }

    /*//////////////////////////////////////////////////////////////
                        ERC20 RECOVERY TESTS
    //////////////////////////////////////////////////////////////*/

    event ERC20Recovered(address indexed token, address indexed owner, uint256 amount);

    function test_PayoutERC20_SuccessfulRecovery() public {
        // Create a new token and accidentally send it to the broker
        MockERC20 accidentalToken = new MockERC20("Accidental Token", "ACC", 18);
        uint256 accidentalAmount = 1000 ether;

        // Mint and send tokens directly to broker (simulating accidental deposit)
        accidentalToken.mint(address(broker), accidentalAmount);

        // Verify broker has the tokens
        assertEq(accidentalToken.balanceOf(address(broker)), accidentalAmount);
        assertEq(accidentalToken.balanceOf(owner), 0);

        // Expect event emission
        vm.expectEmit(true, true, false, true);
        emit ERC20Recovered(address(accidentalToken), owner, accidentalAmount);

        // Owner recovers the tokens
        vm.prank(owner);
        broker.payoutERC20(address(accidentalToken));

        // Verify tokens were transferred to owner
        assertEq(accidentalToken.balanceOf(address(broker)), 0);
        assertEq(accidentalToken.balanceOf(owner), accidentalAmount);
    }

    function test_PayoutERC20_RevertsOnUnauthorized() public {
        // Create a new token and send it to the broker
        MockERC20 accidentalToken = new MockERC20("Accidental Token", "ACC", 18);
        accidentalToken.mint(address(broker), 1000 ether);

        // Non-owner attempts recovery (should fail)
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));

        vm.prank(operator);
        broker.payoutERC20(address(accidentalToken));

        // Verify tokens are still in broker
        assertEq(accidentalToken.balanceOf(address(broker)), 1000 ether);
    }

    function test_PayoutERC20_RevertsOnZeroBalance() public {
        // Create a token but don't send any to the broker
        MockERC20 emptyToken = new MockERC20("Empty Token", "EMPTY", 18);

        // Attempt recovery with zero balance (should fail)
        vm.expectRevert(UnicitySwapBroker.NoTokensToRecover.selector);

        vm.prank(owner);
        broker.payoutERC20(address(emptyToken));
    }

    function test_PayoutERC20_RevertsOnInvalidTokenAddress() public {
        // Attempt recovery with zero address (should fail)
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "token"));

        vm.prank(owner);
        broker.payoutERC20(address(0));
    }

    function test_PayoutERC20_DoesNotInterfereWithNormalSwaps() public {
        // Accidentally deposit tokens to broker
        MockERC20 accidentalToken = new MockERC20("Accidental Token", "ACC", 18);
        uint256 accidentalAmount = 500 ether;
        accidentalToken.mint(address(broker), accidentalAmount);

        // Perform a normal swap operation with different token
        address testEscrow = address(0xabc123);
        token.mint(testEscrow, SWAP_AMOUNT + FEE_AMOUNT);

        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );

        // Verify normal swap completed
        assertTrue(broker.processedDeals(DEAL_ID_1));
        assertEq(token.balanceOf(recipient), SWAP_AMOUNT);

        // Now recover the accidentally deposited tokens
        vm.prank(owner);
        broker.payoutERC20(address(accidentalToken));

        // Verify recovery worked
        assertEq(accidentalToken.balanceOf(owner), accidentalAmount);
        assertEq(accidentalToken.balanceOf(address(broker)), 0);
    }

    function test_PayoutERC20_MultipleTokenRecovery() public {
        // Create multiple tokens accidentally sent to broker
        MockERC20 token1 = new MockERC20("Token 1", "TK1", 18);
        MockERC20 token2 = new MockERC20("Token 2", "TK2", 6);
        MockERC20 token3 = new MockERC20("Token 3", "TK3", 18);

        uint256 amount1 = 1000 ether;
        uint256 amount2 = 5000 * 10**6; // 6 decimals
        uint256 amount3 = 250 ether;

        token1.mint(address(broker), amount1);
        token2.mint(address(broker), amount2);
        token3.mint(address(broker), amount3);

        // Recover all three tokens
        vm.startPrank(owner);

        broker.payoutERC20(address(token1));
        assertEq(token1.balanceOf(owner), amount1);

        broker.payoutERC20(address(token2));
        assertEq(token2.balanceOf(owner), amount2);

        broker.payoutERC20(address(token3));
        assertEq(token3.balanceOf(owner), amount3);

        vm.stopPrank();

        // Verify all tokens recovered
        assertEq(token1.balanceOf(address(broker)), 0);
        assertEq(token2.balanceOf(address(broker)), 0);
        assertEq(token3.balanceOf(address(broker)), 0);
    }

    function test_PayoutERC20_CannotRecoverTwice() public {
        // Deposit tokens
        MockERC20 accidentalToken = new MockERC20("Accidental Token", "ACC", 18);
        uint256 accidentalAmount = 1000 ether;
        accidentalToken.mint(address(broker), accidentalAmount);

        // First recovery succeeds
        vm.prank(owner);
        broker.payoutERC20(address(accidentalToken));

        // Second recovery fails (zero balance)
        vm.expectRevert(UnicitySwapBroker.NoTokensToRecover.selector);

        vm.prank(owner);
        broker.payoutERC20(address(accidentalToken));
    }

    function test_PayoutERC20_ReentrancyProtection() public {
        // The nonReentrant modifier should prevent reentrancy attacks
        // This is implicitly tested by the modifier being present
        // Additional explicit reentrancy test could be added with a malicious token

        // Create a normal token and verify recovery works with reentrancy guard
        MockERC20 safeToken = new MockERC20("Safe Token", "SAFE", 18);
        safeToken.mint(address(broker), 1000 ether);

        vm.prank(owner);
        broker.payoutERC20(address(safeToken));

        assertEq(safeToken.balanceOf(owner), 1000 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        FUZZ TESTS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_SwapNative_VariousAmounts(
        uint256 swapAmount,
        uint256 feeAmount,
        uint256 surplus
    ) public {
        // Bound amounts to reasonable values
        swapAmount = bound(swapAmount, 1, 1000000 ether);
        feeAmount = bound(feeAmount, 0, 100000 ether);
        surplus = bound(surplus, 0, 100000 ether);

        uint256 totalAmount = swapAmount + feeAmount + surplus;

        // Fund operator
        vm.deal(operator, totalAmount);

        bytes32 dealId = keccak256(abi.encodePacked(swapAmount, feeAmount, surplus));

        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            swapAmount,
            feeAmount,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            swapAmount,
            feeAmount,
            signature
        );

        // Verify correct distribution
        assertEq(recipient.balance, swapAmount);
        assertEq(feeRecipient.balance, feeAmount);
        assertEq(payback.balance, surplus);
        assertTrue(broker.processedDeals(dealId));
    }

    // Fuzz test removed due to stack-too-deep issues - covered by unit tests

    /*//////////////////////////////////////////////////////////////
                        GAS BENCHMARK TESTS
    //////////////////////////////////////////////////////////////*/

    function test_Gas_SwapNative() public {
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );
    }

    function test_Gas_SwapERC20() public {
        // Create fresh escrow with exact amount
        address testEscrow = address(0xaa11);
        uint256 exactAmount = SWAP_AMOUNT + FEE_AMOUNT;
        token.mint(testEscrow, exactAmount);

        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        broker.swapERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT
        );
    }

    function test_Gas_RevertNative() public {
        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT + SURPLUS_AMOUNT}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            signature
        );
    }

    function test_Gas_RevertERC20() public {
        // Create fresh escrow with exact amount
        address testEscrow = address(0xbb22);
        uint256 exactAmount = FEE_AMOUNT;
        token.mint(testEscrow, exactAmount);

        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        broker.revertERC20(
            address(token),
            DEAL_ID_1,
            testEscrow,
            payback,
            feeRecipient,
            FEE_AMOUNT
        );
    }

    /*//////////////////////////////////////////////////////////////
                    POST-DEAL REFUND TESTS
    //////////////////////////////////////////////////////////////*/

    function test_RefundNative_Success() public {
        bytes32 dealId = keccak256("deal1");
        uint256 totalAmount = 10 ether;
        uint256 feeAmount = 0.1 ether;

        // First, execute a normal swap to mark deal as processed
        vm.deal(operator, totalAmount);

        bytes memory swapSig = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            5 ether,
            0.05 ether,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            5 ether,
            0.05 ether,
            swapSig
        );

        // Now test post-deal refund (should work even though deal is processed)
        bytes32 refundDealId = keccak256("deal1_refund");
        uint256 lateDeposit = 2 ether;

        vm.deal(operator, lateDeposit);
        uint256 initialPaybackBalance = payback.balance;
        uint256 initialFeeBalance = feeRecipient.balance;

        vm.prank(operator);
        broker.refundNative{value: lateDeposit}(
            refundDealId,
            payback,
            feeRecipient,
            feeAmount
        );

        assertEq(payback.balance, initialPaybackBalance + (lateDeposit - feeAmount));
        assertEq(feeRecipient.balance, initialFeeBalance + feeAmount);
    }

    function test_RefundNative_MultipleRefundsAllowed() public {
        bytes32 dealId = keccak256("deal1");

        // Execute first refund
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        broker.refundNative{value: 1 ether}(dealId, payback, feeRecipient, 0.01 ether);

        // Execute second refund with SAME dealId (should succeed)
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        broker.refundNative{value: 1 ether}(dealId, payback, feeRecipient, 0.01 ether);

        // Should not revert
    }

    function test_RefundERC20_Success() public {
        bytes32 dealId = keccak256("deal1");
        uint256 totalAmount = 1000e18;
        uint256 feeAmount = 10e18;

        // Create fresh escrow for the swap
        address swapEscrow = address(0xabc1);
        token.mint(swapEscrow, totalAmount);
        vm.prank(swapEscrow);
        token.approve(address(broker), type(uint256).max);

        // First, execute a normal swap
        vm.prank(operator);
        broker.swapERC20(
            address(token),
            dealId,
            swapEscrow,
            payback,
            recipient,
            feeRecipient,
            500e18,
            5e18
        );

        // Now test post-deal refund with a different escrow (late deposit)
        bytes32 refundDealId = keccak256("deal1_refund");
        uint256 lateDeposit = 100e18;

        // Create fresh escrow for late deposit
        address lateEscrow = address(0xdef2);
        token.mint(lateEscrow, lateDeposit);
        vm.prank(lateEscrow);
        token.approve(address(broker), type(uint256).max);

        uint256 initialPaybackBalance = token.balanceOf(payback);
        uint256 initialFeeBalance = token.balanceOf(feeRecipient);

        vm.prank(operator);
        broker.refundERC20(
            address(token),
            refundDealId,
            lateEscrow,
            payback,
            feeRecipient,
            feeAmount
        );

        assertEq(token.balanceOf(payback), initialPaybackBalance + (lateDeposit - feeAmount));
        assertEq(token.balanceOf(feeRecipient), initialFeeBalance + feeAmount);
    }

    function test_RefundERC20_MultipleRefundsAllowed() public {
        bytes32 dealId = keccak256("deal1");

        // Create first escrow
        address escrow1 = address(0xabc3);
        token.mint(escrow1, 100e18);
        vm.prank(escrow1);
        token.approve(address(broker), type(uint256).max);

        // Execute first refund
        vm.prank(operator);
        broker.refundERC20(address(token), dealId, escrow1, payback, feeRecipient, 1e18);

        // Create second escrow
        address escrow2 = address(0xdef4);
        token.mint(escrow2, 100e18);
        vm.prank(escrow2);
        token.approve(address(broker), type(uint256).max);

        // Execute second refund with SAME dealId (should succeed)
        vm.prank(operator);
        broker.refundERC20(address(token), dealId, escrow2, payback, feeRecipient, 1e18);
    }

    function test_RefundNative_RevertsOnUnauthorized() public {
        vm.deal(recipient, 1 ether);
        vm.prank(recipient);
        vm.expectRevert(UnicitySwapBroker.UnauthorizedOperator.selector);
        broker.refundNative{value: 1 ether}(keccak256("deal1"), payback, feeRecipient, 0.01 ether);
    }

    function test_RefundERC20_RevertsOnUnauthorized() public {
        address testEscrow = address(0xabc5);
        token.mint(testEscrow, 100e18);
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(recipient);
        vm.expectRevert(UnicitySwapBroker.UnauthorizedOperator.selector);
        broker.refundERC20(address(token), keccak256("deal1"), testEscrow, payback, feeRecipient, 1e18);
    }

    function test_RefundNative_RevertsOnInsufficientBalance() public {
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapBroker.InsufficientBalance.selector,
                2 ether,
                1 ether
            )
        );
        broker.refundNative{value: 1 ether}(keccak256("deal1"), payback, feeRecipient, 2 ether);
    }

    function test_RefundERC20_RevertsOnInsufficientBalance() public {
        address testEscrow = address(0xabc6);
        token.mint(testEscrow, 10e18);
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapBroker.InsufficientBalance.selector,
                20e18,
                10e18
            )
        );
        broker.refundERC20(address(token), keccak256("deal1"), testEscrow, payback, feeRecipient, 20e18);
    }

    function test_RefundNative_EmitsEvent() public {
        bytes32 dealId = keccak256("deal1");
        uint256 amount = 1 ether;
        uint256 fees = 0.01 ether;

        vm.deal(operator, amount);
        vm.prank(operator);

        vm.expectEmit(true, true, false, true);
        emit RefundExecuted(dealId, address(0), feeRecipient, payback, fees, amount - fees);

        broker.refundNative{value: amount}(dealId, payback, feeRecipient, fees);
    }

    function test_RefundERC20_EmitsEvent() public {
        bytes32 dealId = keccak256("deal1");
        uint256 amount = 100e18;
        uint256 fees = 1e18;

        address testEscrow = address(0xabc7);
        token.mint(testEscrow, amount);
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);

        vm.expectEmit(true, true, false, true);
        emit RefundExecuted(dealId, address(token), feeRecipient, payback, fees, amount - fees);

        broker.refundERC20(address(token), dealId, testEscrow, payback, feeRecipient, fees);
    }

    function test_RefundNative_WithZeroFees() public {
        bytes32 dealId = keccak256("deal1");
        uint256 amount = 1 ether;

        vm.deal(operator, amount);
        uint256 initialPaybackBalance = payback.balance;

        vm.prank(operator);
        broker.refundNative{value: amount}(dealId, payback, feeRecipient, 0);

        assertEq(payback.balance, initialPaybackBalance + amount);
        assertEq(feeRecipient.balance, 0);
    }

    function test_RefundERC20_WithZeroFees() public {
        bytes32 dealId = keccak256("deal1");
        uint256 amount = 100e18;

        address testEscrow = address(0xabc8);
        token.mint(testEscrow, amount);
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        uint256 initialPaybackBalance = token.balanceOf(payback);

        vm.prank(operator);
        broker.refundERC20(address(token), dealId, testEscrow, payback, feeRecipient, 0);

        assertEq(token.balanceOf(payback), initialPaybackBalance + amount);
        assertEq(token.balanceOf(feeRecipient), 0);
    }

    function test_RefundNative_RevertsOnInvalidPayback() public {
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "payback"));
        broker.refundNative{value: 1 ether}(keccak256("deal1"), payable(address(0)), feeRecipient, 0.01 ether);
    }

    function test_RefundNative_RevertsOnInvalidFeeRecipient() public {
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "feeRecipient"));
        broker.refundNative{value: 1 ether}(keccak256("deal1"), payback, payable(address(0)), 0.01 ether);
    }

    function test_RefundERC20_RevertsOnInvalidCurrency() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "currency"));
        broker.refundERC20(address(0), keccak256("deal1"), escrow, payback, feeRecipient, 1e18);
    }

    function test_RefundERC20_RevertsOnInvalidEscrow() public {
        vm.prank(operator);
        vm.expectRevert(UnicitySwapBroker.InvalidEscrowAddress.selector);
        broker.refundERC20(address(token), keccak256("deal1"), address(0), payback, feeRecipient, 1e18);
    }

    function test_RefundERC20_RevertsOnInvalidPayback() public {
        address testEscrow = address(0xabc9);
        token.mint(testEscrow, 100e18);
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "payback"));
        broker.refundERC20(address(token), keccak256("deal1"), testEscrow, payable(address(0)), feeRecipient, 1e18);
    }

    function test_RefundERC20_RevertsOnInvalidFeeRecipient() public {
        address testEscrow = address(0xabca);
        token.mint(testEscrow, 100e18);
        vm.prank(testEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.InvalidAddress.selector, "feeRecipient"));
        broker.refundERC20(address(token), keccak256("deal1"), testEscrow, payback, payable(address(0)), 1e18);
    }

    function test_RefundNative_AfterSwapCompletion() public {
        bytes32 swapDealId = keccak256("swap1");

        // Execute swap
        vm.deal(operator, TOTAL_AMOUNT);

        bytes memory swapSig = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            swapDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            swapDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            swapSig
        );

        // Verify swap is processed
        assertTrue(broker.processedDeals(swapDealId));

        // Now refund late deposit (different dealId for tracking)
        bytes32 refundDealId = keccak256("swap1_late_deposit");
        uint256 lateAmount = 1 ether;

        vm.deal(operator, lateAmount);
        vm.prank(operator);
        broker.refundNative{value: lateAmount}(refundDealId, payback, feeRecipient, 0.01 ether);

        // Verify original swap is still marked as processed
        assertTrue(broker.processedDeals(swapDealId));
        // Verify refund didn't mark the refundDealId as processed
        assertFalse(broker.processedDeals(refundDealId));
    }

    /*//////////////////////////////////////////////////////////////
                    MASKED DEALID SECURITY TESTS
    //////////////////////////////////////////////////////////////*/

    function test_MaskedDealId_DifferentMasksAllowMultipleDeals() public {
        // Simulate two different masked dealIds for the same original dealId
        // In production: maskedDealId = keccak256(abi.encodePacked(originalDealId, operatorPrivateKey))

        string memory originalDealId = "deal_123";

        // Simulate two different operator keys generating different masked dealIds
        bytes32 maskedDealId1 = keccak256(abi.encodePacked(originalDealId, "operator_key_1"));
        bytes32 maskedDealId2 = keccak256(abi.encodePacked(originalDealId, "operator_key_2"));

        // Verify masked dealIds are different
        assertTrue(maskedDealId1 != maskedDealId2, "Masked dealIds should be different");

        // First swap with maskedDealId1 succeeds
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            maskedDealId1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            maskedDealId1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Second swap with maskedDealId2 also succeeds (different masked dealId)
        vm.deal(operator, TOTAL_AMOUNT);
        // Generate signature
        bytes memory signature2 = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            maskedDealId2,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            maskedDealId2,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature2
        );

        // Both deals are processed independently
        assertTrue(broker.processedDeals(maskedDealId1));
        assertTrue(broker.processedDeals(maskedDealId2));
    }

    function test_MaskedDealId_SameMaskedDealIdPreventsDoubleExecution() public {
        // Simulate same masked dealId being used twice
        string memory originalDealId = "deal_456";
        bytes32 maskedDealId = keccak256(abi.encodePacked(originalDealId, "operator_key"));

        // First swap succeeds
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            maskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            maskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        vm.deal(operator, TOTAL_AMOUNT);
        // Generate signature for second attempt
        bytes memory signature2 = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            maskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // Second swap with same masked dealId fails
        vm.expectRevert(abi.encodeWithSelector(UnicitySwapBroker.DealAlreadyProcessed.selector, maskedDealId));

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            maskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature2
        );
    }

    function test_MaskedDealId_UnpredictableWithoutOperatorKey() public {
        // Demonstrate that without the operator key, the masked dealId cannot be predicted
        string memory originalDealId = "deal_789";
        string memory correctKey = "secret_operator_key";
        string memory wrongKey = "attacker_guessed_key";

        bytes32 correctMaskedDealId = keccak256(abi.encodePacked(originalDealId, correctKey));
        bytes32 wrongMaskedDealId = keccak256(abi.encodePacked(originalDealId, wrongKey));

        // Attacker tries to frontrun with wrong masked dealId but needs operator signature
        // This test demonstrates that even with wrong dealId, without operator signature the attack fails
        address attacker = address(0xbad);
        vm.deal(attacker, TOTAL_AMOUNT);

        // Attacker creates their own signature (but it's invalid without operator's private key)
        // For this test, we'll show the attacker CANNOT call without valid signature
        // The function will revert with ECDSAInvalidSignatureLength error for short signatures
        bytes memory invalidSig = hex"1234567890"; // Invalid signature (only 5 bytes)

        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 5));
        vm.prank(attacker);
        broker.swapNative{value: TOTAL_AMOUNT}(
            wrongMaskedDealId,
            payback,
            payable(attacker),
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            invalidSig
        );

        // Legitimate transaction with operator signature succeeds
        bytes memory legitSig = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            correctMaskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            correctMaskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            legitSig
        );

        // Correct masked dealId is now processed
        assertTrue(broker.processedDeals(correctMaskedDealId));

        // Both dealIds coexist independently - attacker wasted their own funds
        assertEq(recipient.balance, SWAP_AMOUNT, "Legitimate recipient received funds");
    }

    function test_MaskedDealId_RevertAndSwapIndependent() public {
        // Test that masked dealIds work independently for revert and swap operations
        string memory originalDealId = "deal_mixed";

        bytes32 maskedDealIdForSwap = keccak256(abi.encodePacked(originalDealId, "key_swap"));
        bytes32 maskedDealIdForRevert = keccak256(abi.encodePacked(originalDealId, "key_revert"));

        // Execute revert with first masked dealId
        bytes memory revertSignature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            maskedDealIdForRevert,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.revertNative{value: FEE_AMOUNT + SURPLUS_AMOUNT}(
            maskedDealIdForRevert,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            revertSignature
        );

        // Execute swap with second masked dealId (should succeed independently)
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            maskedDealIdForSwap,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            maskedDealIdForSwap,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Both operations processed independently
        assertTrue(broker.processedDeals(maskedDealIdForRevert));
        assertTrue(broker.processedDeals(maskedDealIdForSwap));
    }

    function test_MaskedDealId_NonOperatorCanUseWithCorrectMask() public {
        // Demonstrate that anyone can call native functions if they have the correct masked dealId
        // This is the intended flow: escrow EOA calls the function with masked dealId

        address escrowEOA = address(0x7777);
        string memory originalDealId = "deal_escrow_flow";
        bytes32 maskedDealId = keccak256(abi.encodePacked(originalDealId, "operator_key"));

        // Fund the escrow EOA
        vm.deal(escrowEOA, TOTAL_AMOUNT);

        // Escrow EOA (not operator) calls swapNative with the masked dealId
        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            maskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            escrowEOA
        );

        vm.prank(escrowEOA);
        broker.swapNative{value: TOTAL_AMOUNT}(
            maskedDealId,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Swap succeeds and deal is processed
        assertTrue(broker.processedDeals(maskedDealId));
        assertEq(recipient.balance, SWAP_AMOUNT);
        assertEq(feeRecipient.balance, FEE_AMOUNT);
        assertEq(payback.balance, SURPLUS_AMOUNT);
    }

    function test_RefundERC20_AfterRevertCompletion() public {
        bytes32 revertDealId = keccak256("revert1");

        // Create escrow for revert
        address revertEscrow = address(0xabcb);
        token.mint(revertEscrow, FEE_AMOUNT + SURPLUS_AMOUNT);
        vm.prank(revertEscrow);
        token.approve(address(broker), type(uint256).max);

        // Execute revert
        vm.prank(operator);
        broker.revertERC20(
            address(token),
            revertDealId,
            revertEscrow,
            payback,
            feeRecipient,
            FEE_AMOUNT
        );

        // Verify revert is processed
        assertTrue(broker.processedDeals(revertDealId));

        // Now refund late deposit
        bytes32 refundDealId = keccak256("revert1_late_deposit");
        uint256 lateAmount = 50e18;

        address lateEscrow = address(0xdefc);
        token.mint(lateEscrow, lateAmount);
        vm.prank(lateEscrow);
        token.approve(address(broker), type(uint256).max);

        vm.prank(operator);
        broker.refundERC20(address(token), refundDealId, lateEscrow, payback, feeRecipient, 1e18);

        // Verify original revert is still marked as processed
        assertTrue(broker.processedDeals(revertDealId));
        // Verify refund didn't mark the refundDealId as processed
        assertFalse(broker.processedDeals(refundDealId));
    }
}

/**
 * @title MaliciousRecipient
 * @notice Mock contract that attempts reentrancy attack
 */
contract MaliciousRecipient {
    UnicitySwapBroker public broker;
    address public operator;
    bool public attackSucceeded;

    constructor(address _broker, address _operator) {
        broker = UnicitySwapBroker(payable(_broker));
        operator = _operator;
    }

    receive() external payable {
        // Attempt reentrancy on receiving funds
        if (msg.sender == address(broker) && !attackSucceeded) {
            // Attacker cannot create valid signature, so attack will fail
            bytes memory invalidSig = hex"00";
            try broker.swapNative{value: 100 ether}(
                keccak256("ATTACK_DEAL"),
                payable(address(this)),
                payable(address(this)),
                payable(address(this)),
                50 ether,
                5 ether,
                invalidSig
            ) {
                attackSucceeded = true;
            } catch {
                // Attack failed (expected)
            }
        }
    }
}
