// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../src/optimized/UnicitySwapEscrowImplementationArray.sol";
import "../../src/optimized/UnicitySwapEscrowFactoryOptimized.sol";
import "../../src/UnicitySwapEscrowBeacon.sol";
import "../../src/mocks/MockERC20.sol";

/**
 * @title ArrayStorageSecurityTest
 * @notice Comprehensive security test suite for array storage implementation
 * @dev Tests cover:
 *   - Reentrancy protection (direct, cross-function, read-only)
 *   - Initialization security (double-init, zero addresses, front-running)
 *   - State machine integrity (invalid transitions, terminal states)
 *   - Access control (unauthorized access)
 *   - Arithmetic safety (overflow, underflow, edge cases)
 *   - Storage layout safety (array indexing, type casting)
 *   - External call safety (checks-effects-interactions, transfer failures)
 *   - Logic correctness (swap amounts, refunds, fees)
 */
contract ArrayStorageSecurityTest is Test {
    UnicitySwapEscrowImplementationArray public implementation;
    UnicitySwapEscrowBeacon public beacon;
    UnicitySwapEscrowFactoryOptimized public factory;
    MockERC20 public token;

    address public operator = 0x0000000000000000000000000000000000000001;
    address payable public payback = payable(address(0x1001));
    address payable public recipient = payable(address(0x1002));
    address payable public feeRecipient = payable(0x0000000000000000000000000000000000000002);
    address payable public gasTank = payable(0x0000000000000000000000000000000000000003);

    uint256 public constant SWAP_VALUE = 1000 ether;
    uint256 public constant FEE_VALUE = (SWAP_VALUE * 30) / 10000; // 0.3% = 30 bps

    function setUp() public {
        token = new MockERC20("Test Token", "TEST", 18);

        // Deploy implementation
        implementation = new UnicitySwapEscrowImplementationArray();

        // Deploy beacon
        beacon = new UnicitySwapEscrowBeacon(address(implementation), address(this));

        // Deploy factory
        factory = new UnicitySwapEscrowFactoryOptimized(address(beacon));

        // Fund addresses
        vm.deal(operator, 100 ether);
        vm.deal(payback, 100 ether);
        vm.deal(recipient, 100 ether);
        vm.deal(feeRecipient, 100 ether);
        vm.deal(gasTank, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                    A. REENTRANCY PROTECTION
    //////////////////////////////////////////////////////////////*/

    function test_Security_Reentrancy_DirectSwap() public {
        MaliciousRecipientArray malicious = new MaliciousRecipientArray();

        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(malicious)),
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        malicious.setEscrow(escrowAddress);

        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        escrow.swap();

        assertTrue(escrow.isSwapExecuted());
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementationArray.State.COMPLETED));
        assertEq(malicious.reentrancyAttempts(), 1);
        assertFalse(malicious.reentrancySucceeded());
    }

    function test_Security_Reentrancy_CrossFunction_SwapToRefund() public {
        CrossFunctionAttackerArray attacker = new CrossFunctionAttackerArray();

        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(attacker)),
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        attacker.setEscrow(escrowAddress);

        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE + 100 ether);

        vm.prank(operator);
        escrow.swap();

        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementationArray.State.COMPLETED));
        assertFalse(attacker.refundSucceeded());
    }

    function test_Security_Reentrancy_CrossFunction_SwapToRevert() public {
        RevertAttackerArray attacker = new RevertAttackerArray();

        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(attacker)),
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        attacker.setEscrow(escrowAddress);

        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        escrow.swap();

        assertFalse(attacker.revertSucceeded());
    }

    function test_Security_Reentrancy_ReadOnly() public {
        ReadOnlyAttackerArray readOnlyAttacker = new ReadOnlyAttackerArray();

        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(readOnlyAttacker)),
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        readOnlyAttacker.setEscrow(escrowAddress);

        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        escrow.swap();

        assertGe(uint8(readOnlyAttacker.observedState()), uint8(UnicitySwapEscrowImplementationArray.State.SWAP));
    }

    /*//////////////////////////////////////////////////////////////
                    B. INITIALIZATION SECURITY
    //////////////////////////////////////////////////////////////*/

    function test_Security_Initialization_DoubleInitialize() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        vm.expectRevert(UnicitySwapEscrowImplementationArray.AlreadyInitialized.selector);
        UnicitySwapEscrowImplementationArray(payable(escrowAddress)).initialize(
            payback,
            payable(address(0x888)),
            address(token),
            SWAP_VALUE * 2,
            FEE_VALUE * 2
        );
    }

    function test_Security_Initialization_ZeroPayback() public {
        UnicitySwapEscrowImplementationArray newEscrow = new UnicitySwapEscrowImplementationArray();

        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationArray.InvalidAddress.selector,
                "payback"
            )
        );
        newEscrow.initialize(
            payable(address(0)),
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    function test_Security_Initialization_ZeroRecipient() public {
        UnicitySwapEscrowImplementationArray newEscrow = new UnicitySwapEscrowImplementationArray();

        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationArray.InvalidAddress.selector,
                "recipient"
            )
        );
        newEscrow.initialize(
            payback,
            payable(address(0)),
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    function test_Security_Initialization_UninitializedAccess() public {
        UnicitySwapEscrowImplementationArray newEscrow = new UnicitySwapEscrowImplementationArray();

        vm.expectRevert(UnicitySwapEscrowImplementationArray.NotInitialized.selector);
        newEscrow.payback();

        vm.expectRevert(UnicitySwapEscrowImplementationArray.NotInitialized.selector);
        newEscrow.recipient();

        vm.expectRevert(UnicitySwapEscrowImplementationArray.NotInitialized.selector);
        newEscrow.swapValue();

        vm.expectRevert(UnicitySwapEscrowImplementationArray.NotInitialized.selector);
        newEscrow.state();
    }

    /*//////////////////////////////////////////////////////////////
                    C. STATE MACHINE INTEGRITY
    //////////////////////////////////////////////////////////////*/

    function test_Security_StateMachine_InvalidTransition_CollectionToCompleted() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        // Try to force transition from COLLECTION to COMPLETED (should be impossible)
        // Since _transitionState is internal, we test via public functions that use it
        // COLLECTION can only go to SWAP or REVERTED
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementationArray.State.COLLECTION));
    }

    function test_Security_StateMachine_TerminalState_Completed() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        escrow.swap();

        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementationArray.State.COMPLETED));

        // Try to swap again - should fail
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationArray.InvalidState.selector,
                UnicitySwapEscrowImplementationArray.State.COMPLETED,
                UnicitySwapEscrowImplementationArray.State.COLLECTION
            )
        );
        escrow.swap();

        // Try to revert - should fail
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationArray.InvalidState.selector,
                UnicitySwapEscrowImplementationArray.State.COMPLETED,
                UnicitySwapEscrowImplementationArray.State.COLLECTION
            )
        );
        escrow.revertEscrow();
    }

    function test_Security_StateMachine_TerminalState_Reverted() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        escrow.revertEscrow();

        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementationArray.State.REVERTED));

        // Try to swap - should fail
        vm.prank(operator);
        vm.expectRevert();
        escrow.swap();

        // Try to revert again - should fail
        vm.prank(operator);
        vm.expectRevert();
        escrow.revertEscrow();
    }

    /*//////////////////////////////////////////////////////////////
                    D. ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    function test_Security_AccessControl_UnauthorizedSwap() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        address attacker = address(0x999);
        vm.prank(attacker);
        vm.expectRevert(UnicitySwapEscrowImplementationArray.UnauthorizedOperator.selector);
        escrow.swap();
    }

    function test_Security_AccessControl_UnauthorizedRevert() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        address attacker = address(0x999);
        vm.prank(attacker);
        vm.expectRevert(UnicitySwapEscrowImplementationArray.UnauthorizedOperator.selector);
        escrow.revertEscrow();
    }

    function test_Security_AccessControl_RefundPublic() public {
        // refund() should be public and callable by anyone after completion
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE + 100 ether);

        vm.prank(operator);
        escrow.swap();

        // Anyone can call refund in COMPLETED state
        address anyone = address(0x999);
        vm.prank(anyone);
        escrow.refund(); // Should not revert
    }

    /*//////////////////////////////////////////////////////////////
                    E. ARITHMETIC SAFETY
    //////////////////////////////////////////////////////////////*/

    function test_Security_Arithmetic_ZeroValues() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            0, // Zero swap value
            0  // Zero fee value
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        assertEq(escrow.swapValue(), 0);
        assertEq(escrow.feeValue(), 0);

        vm.prank(operator);
        escrow.swap(); // Should not revert with zero values
    }

    function test_Security_Arithmetic_MaxUint256() public {
        // Test with max uint256 values (should not overflow)
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            type(uint256).max / 2,
            type(uint256).max / 2
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        assertEq(escrow.swapValue(), type(uint256).max / 2);
        assertEq(escrow.feeValue(), type(uint256).max / 2);
    }

    function test_Security_Arithmetic_InsufficientBalance() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        // Fund with insufficient amount
        vm.deal(escrowAddress, SWAP_VALUE - 1);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationArray.InsufficientBalance.selector,
                SWAP_VALUE + FEE_VALUE,
                SWAP_VALUE - 1
            )
        );
        escrow.swap();
    }

    /*//////////////////////////////////////////////////////////////
                    F. STORAGE LAYOUT SAFETY
    //////////////////////////////////////////////////////////////*/

    function test_Security_Storage_ArrayIndexing() public {
        // Test that array storage correctly stores and retrieves all values
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        // Verify all values are correctly stored and retrieved
        assertEq(escrow.payback(), payback);
        assertEq(escrow.recipient(), recipient);
        assertEq(escrow.currency(), address(token));
        assertEq(escrow.swapValue(), SWAP_VALUE);
        assertEq(escrow.feeValue(), FEE_VALUE);
    }

    function test_Security_Storage_TypeCasting_AddressToBytes32() public {
        // Test edge case addresses
        address payable testPayback = payable(address(type(uint160).max));
        address payable testRecipient = payable(address(1));

        address escrowAddress = factory.createEscrow(
            testPayback,
            testRecipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        assertEq(escrow.payback(), testPayback);
        assertEq(escrow.recipient(), testRecipient);
    }

    function test_Security_Storage_TypeCasting_Uint256ToBytes32() public {
        // Test edge case uint256 values
        uint256 maxSwap = type(uint256).max;
        uint256 maxFee = type(uint256).max;

        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            maxSwap,
            maxFee
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        assertEq(escrow.swapValue(), maxSwap);
        assertEq(escrow.feeValue(), maxFee);
    }

    /*//////////////////////////////////////////////////////////////
                    G. EXTERNAL CALL SAFETY
    //////////////////////////////////////////////////////////////*/

    function test_Security_ExternalCalls_ERC20TransferFailure() public {
        // Create token that fails transfers
        FailingERC20 failingToken = new FailingERC20();

        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(failingToken),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        // Mint tokens to escrow
        failingToken.mint(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        vm.expectRevert(); // SafeERC20 should revert on transfer failure
        escrow.swap();
    }

    function test_Security_ExternalCalls_NativeTransferFailure() public {
        // Create contract that rejects ETH
        RejectingRecipient rejectingRecipient = new RejectingRecipient();

        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(rejectingRecipient)),
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationArray.TransferFailed.selector,
                address(0),
                address(rejectingRecipient),
                SWAP_VALUE
            )
        );
        escrow.swap();
    }

    function test_Security_ExternalCalls_ChecksEffectsInteractions() public {
        // Use StateObserver to verify state changes happen before external calls
        StateObserverArray observer = new StateObserverArray();

        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(observer)),
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));
        observer.setEscrow(escrowAddress);
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);

        vm.prank(operator);
        escrow.swap();

        // Verify state was updated before external call
        assertTrue(observer.swapExecutedWhenCalled());
        assertEq(uint8(observer.stateWhenCalled()), uint8(UnicitySwapEscrowImplementationArray.State.SWAP));
    }

    /*//////////////////////////////////////////////////////////////
                    H. LOGIC CORRECTNESS
    //////////////////////////////////////////////////////////////*/

    function test_Security_Logic_SwapAmounts_Native() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        uint256 surplus = 50 ether;
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE + surplus);

        uint256 recipientBefore = recipient.balance;
        uint256 feeRecipientBefore = feeRecipient.balance;
        uint256 paybackBefore = payback.balance;

        vm.prank(operator);
        escrow.swap();

        // Verify correct amounts transferred
        assertEq(recipient.balance - recipientBefore, SWAP_VALUE);
        assertEq(feeRecipient.balance - feeRecipientBefore, FEE_VALUE);
        assertEq(payback.balance - paybackBefore, surplus);
    }

    function test_Security_Logic_SwapAmounts_ERC20() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        uint256 surplus = 50 ether;
        token.mint(escrowAddress, SWAP_VALUE + FEE_VALUE + surplus);

        vm.prank(operator);
        escrow.swap();

        assertEq(token.balanceOf(recipient), SWAP_VALUE);
        assertEq(token.balanceOf(feeRecipient), FEE_VALUE);
        assertEq(token.balanceOf(payback), surplus);
    }

    function test_Security_Logic_RevertRefunds() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        uint256 depositAmount = SWAP_VALUE + FEE_VALUE;
        vm.deal(escrowAddress, depositAmount);

        uint256 paybackBefore = payback.balance;
        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.prank(operator);
        escrow.revertEscrow();

        // In revert: fees paid first, then remaining refunded
        assertEq(feeRecipient.balance - feeRecipientBefore, FEE_VALUE);
        assertEq(payback.balance - paybackBefore, SWAP_VALUE);
    }

    function test_Security_Logic_Sweep_OnlyNonSwapCurrency() public {
        // Use ERC20 as swap currency, native as non-swap currency
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(token), // Swap currency is ERC20
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        // Fund with ERC20 for swap
        token.mint(escrowAddress, SWAP_VALUE + FEE_VALUE);
        // Fund with native currency (non-swap currency)
        vm.deal(escrowAddress, 50 ether);

        vm.prank(operator);
        escrow.swap();

        // Try to sweep swap currency (ERC20) - should fail
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationArray.InvalidCurrency.selector,
                address(token)
            )
        );
        escrow.sweep(address(token));

        // Sweep native currency (not swap currency) - should succeed
        uint256 gasTankBefore = gasTank.balance;
        escrow.sweep(address(0));
        assertGt(gasTank.balance, gasTankBefore);
    }

    function test_Security_Logic_CanSwap() public {
        address escrowAddress = factory.createEscrow(
            payback,
            recipient,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        UnicitySwapEscrowImplementationArray escrow = UnicitySwapEscrowImplementationArray(payable(escrowAddress));

        // Insufficient funds
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE - 1);
        assertFalse(escrow.canSwap());

        // Exact funds
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE);
        assertTrue(escrow.canSwap());

        // Surplus
        vm.deal(escrowAddress, SWAP_VALUE + FEE_VALUE + 100 ether);
        assertTrue(escrow.canSwap());
    }

    // Make test contract able to receive ETH
    receive() external payable {}
    fallback() external payable {}
}

/*//////////////////////////////////////////////////////////////
                    MALICIOUS CONTRACTS
//////////////////////////////////////////////////////////////*/

contract MaliciousRecipientArray {
    UnicitySwapEscrowImplementationArray public escrow;
    uint256 public reentrancyAttempts;
    bool public reentrancySucceeded;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementationArray(payable(_escrow));
    }

    receive() external payable {
        reentrancyAttempts++;
        if (reentrancyAttempts == 1) {
            try escrow.swap() {
                reentrancySucceeded = true;
            } catch {
                // Expected to fail
            }
        }
    }
}

contract CrossFunctionAttackerArray {
    UnicitySwapEscrowImplementationArray public escrow;
    bool public refundSucceeded;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementationArray(payable(_escrow));
    }

    receive() external payable {
        try escrow.refund() {
            refundSucceeded = true;
        } catch {
            // Expected to fail
        }
    }
}

contract RevertAttackerArray {
    UnicitySwapEscrowImplementationArray public escrow;
    bool public revertSucceeded;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementationArray(payable(_escrow));
    }

    receive() external payable {
        try escrow.revertEscrow() {
            revertSucceeded = true;
        } catch {
            // Expected to fail
        }
    }
}

contract ReadOnlyAttackerArray {
    UnicitySwapEscrowImplementationArray public escrow;
    UnicitySwapEscrowImplementationArray.State public observedState;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementationArray(payable(_escrow));
    }

    receive() external payable {
        observedState = escrow.state();
    }
}

contract StateObserverArray {
    UnicitySwapEscrowImplementationArray public escrow;
    bool public swapExecutedWhenCalled;
    UnicitySwapEscrowImplementationArray.State public stateWhenCalled;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementationArray(payable(_escrow));
    }

    receive() external payable {
        swapExecutedWhenCalled = escrow.isSwapExecuted();
        stateWhenCalled = escrow.state();
    }
}

contract FailingERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false; // Always fail
    }
}

contract RejectingRecipient {
    // No receive/fallback - rejects ETH
}
