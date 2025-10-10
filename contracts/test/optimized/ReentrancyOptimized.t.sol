// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../src/optimized/UnicitySwapEscrowImplementation.sol";
import "../../src/optimized/UnicitySwapEscrowFactoryOptimized.sol";
import "../../src/UnicitySwapEscrowBeacon.sol";
import "../../src/mocks/MockERC20.sol";

/**
 * @title ReentrancyOptimizedTest
 * @notice Security tests for reentrancy vulnerabilities in optimized implementation
 */
contract ReentrancyOptimizedTest is Test {
    UnicitySwapEscrowImplementation public implementation;
    UnicitySwapEscrowBeacon public beacon;
    UnicitySwapEscrowFactoryOptimized public factory;
    MockERC20 public token;

    address public operator = 0x0000000000000000000000000000000000000001;
    address payable public payback = payable(address(0x2));
    address payable public feeRecipient = payable(0x0000000000000000000000000000000000000002);
    address payable public gasTank = payable(0x0000000000000000000000000000000000000003);

    uint256 public constant SWAP_VALUE = 1000 ether;

    function setUp() public {
        token = new MockERC20("Test Token", "TEST", 18);

        // Deploy implementation
        implementation = new UnicitySwapEscrowImplementation();

        // Deploy beacon
        beacon = new UnicitySwapEscrowBeacon(address(implementation), address(this));

        // Deploy factory
        factory = new UnicitySwapEscrowFactoryOptimized(address(beacon));

        // Fund addresses
        vm.deal(operator, 100 ether);
        vm.deal(feeRecipient, 100 ether);
        vm.deal(gasTank, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                    REENTRANCY ATTACK TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ReentrancyAttack_DirectSwap() public {
        // Create malicious recipient
        MaliciousRecipient malicious = new MaliciousRecipient();

        // Create escrow with malicious recipient
        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(malicious)),
            address(0), // Native currency for callback
            SWAP_VALUE,
            (SWAP_VALUE * 30) / 10000
        );

        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));
        malicious.setEscrow(escrowAddress);

        // Fund escrow
        uint256 feeVal = (SWAP_VALUE * 30) / 10000;
        vm.deal(escrowAddress, SWAP_VALUE + feeVal);

        // Execute swap - malicious contract will try to reenter
        vm.prank(operator);
        escrow.swap();

        // Verify only one swap occurred
        assertTrue(escrow.isSwapExecuted());
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementation.State.COMPLETED));

        // Check malicious contract attack failed
        assertEq(malicious.reentrancyAttempts(), 1);
        assertFalse(malicious.reentrancySucceeded());
    }

    function test_CrossFunctionReentrancy_SwapToRefund() public {
        // Create contract that tries to call refund during swap
        CrossFunctionAttacker attacker = new CrossFunctionAttacker();

        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(attacker)),
            address(0),
            SWAP_VALUE,
            (SWAP_VALUE * 30) / 10000
        );

        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));
        attacker.setEscrow(escrowAddress);

        // Fund escrow with extra for refund
        uint256 feeVal = (SWAP_VALUE * 30) / 10000;
        vm.deal(escrowAddress, SWAP_VALUE + feeVal + 100 ether);

        // Execute swap - attacker will try to call refund during callback
        vm.prank(operator);
        escrow.swap();

        // Verify state is correct
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrowImplementation.State.COMPLETED));

        // Attacker should have failed to call refund during swap
        assertFalse(attacker.refundSucceeded());
    }

    function test_ReadOnlyReentrancy_StateCheck() public {
        ReadOnlyAttacker readOnlyAttacker = new ReadOnlyAttacker();

        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(readOnlyAttacker)),
            address(0),
            SWAP_VALUE,
            (SWAP_VALUE * 30) / 10000
        );

        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(escrowAddress));
        readOnlyAttacker.setEscrow(escrowAddress);

        // Fund escrow
        uint256 feeVal = (SWAP_VALUE * 30) / 10000;
        vm.deal(escrowAddress, SWAP_VALUE + feeVal);

        // Execute swap - attacker will read state during callback
        vm.prank(operator);
        escrow.swap();

        // Verify attacker saw correct state
        // During callback, state should be SWAP or COMPLETED
        assertGe(uint8(readOnlyAttacker.observedState()), uint8(UnicitySwapEscrowImplementation.State.SWAP));
    }

    function test_Reentrancy_DoubleInitialize() public {
        // Create escrow
        address escrowAddress = factory.createEscrow(
            payback,
            payable(address(0x999)),
            address(token),
            SWAP_VALUE,
            (SWAP_VALUE * 30) / 10000
        );

        // Try to reinitialize - should fail
        vm.expectRevert(UnicitySwapEscrowImplementation.AlreadyInitialized.selector);
        UnicitySwapEscrowImplementation(payable(escrowAddress)).initialize(
            payback,
            payable(address(0x888)),
            address(token),
            SWAP_VALUE * 2,
            (SWAP_VALUE * 2 * 30) / 10000
        );
    }

    // Make test contract able to receive ETH
    receive() external payable {}
    fallback() external payable {}
}

/**
 * @title MaliciousRecipient
 * @notice Attempts direct reentrancy on swap()
 */
contract MaliciousRecipient {
    UnicitySwapEscrowImplementation public escrow;
    uint256 public reentrancyAttempts;
    bool public reentrancySucceeded;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementation(payable(_escrow));
    }

    receive() external payable {
        reentrancyAttempts++;

        if (reentrancyAttempts == 1) {
            // Try to reenter swap
            try escrow.swap() {
                reentrancySucceeded = true;
            } catch {
                // Expected to fail
            }
        }
    }
}

/**
 * @title CrossFunctionAttacker
 * @notice Attempts cross-function reentrancy (swap -> refund)
 */
contract CrossFunctionAttacker {
    UnicitySwapEscrowImplementation public escrow;
    bool public refundSucceeded;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementation(payable(_escrow));
    }

    receive() external payable {
        // Try to call refund during swap
        try escrow.refund() {
            refundSucceeded = true;
        } catch {
            // Expected to fail
        }
    }
}

/**
 * @title ReadOnlyAttacker
 * @notice Observes state during reentrancy (read-only)
 */
contract ReadOnlyAttacker {
    UnicitySwapEscrowImplementation public escrow;
    UnicitySwapEscrowImplementation.State public observedState;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrowImplementation(payable(_escrow));
    }

    receive() external payable {
        // Read state during callback
        observedState = escrow.state();
    }
}
