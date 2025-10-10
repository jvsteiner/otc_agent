// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../src/UnicitySwapEscrow.sol";
import "../../src/mocks/ReentrancyAttacker.sol";
import "../../src/mocks/MockERC20.sol";

/**
 * @title ReentrancyTest
 * @notice Security tests for reentrancy vulnerabilities
 */
contract ReentrancyTest is Test {
    UnicitySwapEscrow public escrow;
    MockERC20 public token;
    ReentrancyAttacker public attacker;

    address public operator = address(0x1);
    address payable public payback = payable(address(0x2));
    address payable public feeRecipient = payable(address(0x4));
    address payable public gasTank = payable(address(0x5));

    bytes32 public constant DEAL_ID = keccak256("REENTRANCY_TEST");
    uint256 public constant SWAP_VALUE = 1000 ether;
    uint256 public constant FEE_VALUE = 10 ether;

    function setUp() public {
        token = new MockERC20("Test Token", "TEST", 18);

        // Create initial escrow (will be replaced in individual tests)
        escrow = new UnicitySwapEscrow(
            operator,
            DEAL_ID,
            payback,
            payable(address(0x7)), // Valid recipient
            feeRecipient,
            gasTank,
            address(0), // Native currency
            SWAP_VALUE,
            FEE_VALUE
        );
    }

    /*//////////////////////////////////////////////////////////////
                    REENTRANCY ATTACK TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ReentrancyAttack_Swap_ShouldFail() public {
        // Create attacker with placeholder escrow (will update later)
        attacker = new ReentrancyAttacker(address(0x1), 3);

        // Create escrow where attacker is both operator AND recipient
        // This allows the attack to proceed past authorization checks
        escrow = new UnicitySwapEscrow(
            address(attacker), // Attacker as operator - can call swap()
            keccak256("ATTACK_SWAP"),
            payable(address(this)),
            payable(address(attacker)), // Attacker as recipient - receives callback
            feeRecipient,
            gasTank,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Update attacker's escrow reference to the real escrow
        attacker.setEscrow(address(escrow));

        // Fund escrow
        vm.deal(address(escrow), SWAP_VALUE + FEE_VALUE);

        // Attempt attack - reentrancy guard should prevent multiple swaps
        attacker.attack();

        // Verify swap completed only once (reentrancy guard worked)
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.COMPLETED));
        assertTrue(escrow.isSwapExecuted());

        // Attacker should have received funds only once (not 3 times despite 3 attempts)
        assertEq(address(attacker).balance, SWAP_VALUE);

        // Verify attacker tried to reenter but failed
        assertEq(attacker.attackCount(), 1); // Only 1 attempt made (reentrancy blocked subsequent ones)
    }

    function test_ReentrancyAttack_Refund_ShouldFail() public {
        // Create attacker with placeholder escrow (will update later)
        attacker = new ReentrancyAttacker(address(0x1), 3);

        // Deploy escrow with attacker as payback
        escrow = new UnicitySwapEscrow(
            address(this),
            keccak256("ATTACK_REFUND"),
            payable(address(attacker)), // Attacker as payback
            payable(address(0x3)),
            feeRecipient,
            gasTank,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Update attacker's escrow reference to the real escrow
        attacker.setEscrow(address(escrow));

        // Fund and revert to transition to REVERTED state
        uint256 amount = 500 ether;
        vm.deal(address(escrow), amount);
        escrow.revertEscrow();

        // Verify initial refund was sent (500 - 10 fee = 490 ether)
        assertEq(address(attacker).balance, 490 ether);

        // Add more funds to escrow for second refund attempt
        vm.deal(address(escrow), 100 ether);

        // Record balance before second refund
        uint256 attackerBalanceBefore = address(attacker).balance;

        // Attacker tries to refund - reentrancy guard should allow this
        // (refund() is designed to be callable multiple times in REVERTED state)
        attacker.attackRefund();

        // Should have received the new refund (100 ether)
        assertEq(address(attacker).balance, attackerBalanceBefore + 100 ether);

        // Note: The attacker's receive() tries to call swap() (not refund)
        // This will fail because state is REVERTED, not COLLECTION
        // So attackCount will be 1 from the first receive callback
        // The fallback() which tries refund() won't be called because receive() exists
        assertEq(attacker.attackCount(), 1);
    }

    function test_DirectReentrancy_Swap() public {
        // Create malicious contract as recipient
        MaliciousRecipient malicious = new MaliciousRecipient();

        escrow = new UnicitySwapEscrow(
            address(this),
            keccak256("DIRECT_ATTACK"),
            payable(address(this)),
            payable(address(malicious)),
            feeRecipient,
            gasTank,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        // Set escrow in malicious contract
        malicious.setEscrow(address(escrow));

        // Fund escrow
        vm.deal(address(escrow), SWAP_VALUE + FEE_VALUE);

        // Execute swap - malicious contract will try to reenter
        escrow.swap();

        // Verify only one swap occurred
        assertTrue(escrow.isSwapExecuted());
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.COMPLETED));

        // Check malicious contract attack failed
        assertEq(malicious.reentrancyAttempts(), 1);
        assertFalse(malicious.reentrancySucceeded());
    }

    /*//////////////////////////////////////////////////////////////
                    CROSS-FUNCTION REENTRANCY
    //////////////////////////////////////////////////////////////*/

    function test_CrossFunctionReentrancy_SwapToRefund() public {
        // Create contract that tries to call refund during swap
        CrossFunctionAttacker crossAttacker = new CrossFunctionAttacker();

        escrow = new UnicitySwapEscrow(
            address(this),
            keccak256("CROSS_ATTACK"),
            payable(address(this)), // Test contract as payback
            payable(address(crossAttacker)),
            feeRecipient,
            gasTank,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        crossAttacker.setEscrow(address(escrow));

        // Fund escrow with extra for refund
        vm.deal(address(escrow), SWAP_VALUE + FEE_VALUE + 100 ether);

        // Execute swap - attacker will try to call refund during callback
        escrow.swap();

        // Verify state is correct
        assertEq(uint8(escrow.state()), uint8(UnicitySwapEscrow.State.COMPLETED));

        // Attacker should have failed to call refund during swap
        // Either due to reentrancy guard OR invalid state (SWAP vs COMPLETED/REVERTED)
        assertFalse(crossAttacker.refundSucceeded());
    }

    // Make test contract able to receive ETH for refunds
    receive() external payable {}
    fallback() external payable {}

    /*//////////////////////////////////////////////////////////////
                    READ-ONLY REENTRANCY
    //////////////////////////////////////////////////////////////*/

    function test_ReadOnlyReentrancy_StateCheck() public {
        ReadOnlyAttacker readOnlyAttacker = new ReadOnlyAttacker();

        escrow = new UnicitySwapEscrow(
            address(this),
            keccak256("READONLY_ATTACK"),
            payable(address(this)),
            payable(address(readOnlyAttacker)),
            feeRecipient,
            gasTank,
            address(0),
            SWAP_VALUE,
            FEE_VALUE
        );

        readOnlyAttacker.setEscrow(address(escrow));

        // Fund escrow
        vm.deal(address(escrow), SWAP_VALUE + FEE_VALUE);

        // Execute swap - attacker will read state during callback
        escrow.swap();

        // Verify attacker saw correct state
        // During callback, state should be SWAP or COMPLETED
        assertGe(uint8(readOnlyAttacker.observedState()), uint8(UnicitySwapEscrow.State.SWAP));
    }
}

/**
 * @title MaliciousRecipient
 * @notice Attempts direct reentrancy on swap()
 */
contract MaliciousRecipient {
    UnicitySwapEscrow public escrow;
    uint256 public reentrancyAttempts;
    bool public reentrancySucceeded;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrow(payable(_escrow));
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
    UnicitySwapEscrow public escrow;
    bool public refundSucceeded;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrow(payable(_escrow));
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
    UnicitySwapEscrow public escrow;
    UnicitySwapEscrow.State public observedState;

    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrow(payable(_escrow));
    }

    receive() external payable {
        // Read state during callback
        observedState = escrow.state();
    }
}
