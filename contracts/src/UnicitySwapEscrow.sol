// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title UnicitySwapEscrow
 * @notice Production-grade escrow contract for OTC cross-chain swaps
 * @dev Implements state machine: COLLECTION -> SWAP -> COMPLETED or COLLECTION -> REVERTED
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * - State transitions are atomic and irreversible
 * - SWAP state can only be entered once (prevents double-swap)
 * - Re-entrancy protection on all state-changing functions
 * - Safe ERC20 transfers with proper error handling
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ENUMS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Escrow state machine
     * @dev State transitions:
     *      COLLECTION -> SWAP -> COMPLETED (success path)
     *      COLLECTION -> REVERTED (failure path)
     *      NEVER: SWAP <-> REVERTED (one-way only)
     */
    enum State {
        COLLECTION,  // Initial state, collecting funds
        SWAP,        // Executing swap (transition only, never persisted)
        COMPLETED,   // Swap completed successfully
        REVERTED     // Swap reverted/cancelled
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event StateTransition(State indexed from, State indexed to);
    event SwapExecuted(address indexed recipient, uint256 swapValue, uint256 feeValue);
    event Reverted(address indexed payback, uint256 amount);
    event Refunded(address indexed payback, uint256 amount);
    event Swept(address indexed currency, address indexed gasTank, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error UnauthorizedOperator();
    error InvalidState(State current, State required);
    error InvalidStateMultiple(State current, State required1, State required2);
    error InvalidStateTransition(State from, State to);
    error InvalidAddress(string param);
    error InsufficientBalance(uint256 required, uint256 available);
    error TransferFailed(address token, address to, uint256 amount);
    error InvalidCurrency(address currency);
    error AlreadyExecuted();

    /*//////////////////////////////////////////////////////////////
                            IMMUTABLE STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Operator authorized to trigger swap/revert
    address public immutable escrowOperator;

    /// @notice Unique deal identifier
    bytes32 public immutable dealID;

    /// @notice Refund destination for remaining balance
    address payable public immutable payback;

    /// @notice Swap recipient address
    address payable public immutable recipient;

    /// @notice Fee recipient for operator commission
    address payable public immutable feeRecipient;

    /// @notice Sweep destination for leftover assets
    address payable public immutable gasTank;

    /// @notice ERC20 token (address(0) for native currency)
    address public immutable currency;

    /// @notice Required balance to execute swap
    uint256 public immutable swapValue;

    /// @notice Operator fee amount
    uint256 public immutable feeValue;

    /*//////////////////////////////////////////////////////////////
                            MUTABLE STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Current escrow state
    State public state;

    /// @notice Tracks if swap has been executed (critical security flag)
    bool private _swapExecuted;

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOperator() {
        if (msg.sender != escrowOperator) revert UnauthorizedOperator();
        _;
    }

    modifier inState(State required) {
        if (state != required) revert InvalidState(state, required);
        _;
    }

    modifier inStates(State required1, State required2) {
        if (state != required1 && state != required2) {
            revert InvalidStateMultiple(state, required1, required2);
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize escrow with immutable parameters
     * @param _escrowOperator Address authorized to trigger swap/revert
     * @param _dealID Unique deal identifier
     * @param _payback Refund address for remaining balance
     * @param _recipient Swap recipient address
     * @param _feeRecipient Operator fee destination
     * @param _gasTank Sweep destination for leftover assets
     * @param _currency ERC20 token (address(0) for native)
     * @param _swapValue Required balance to execute swap
     * @param _feeValue Operator commission amount
     */
    constructor(
        address _escrowOperator,
        bytes32 _dealID,
        address payable _payback,
        address payable _recipient,
        address payable _feeRecipient,
        address payable _gasTank,
        address _currency,
        uint256 _swapValue,
        uint256 _feeValue
    ) {
        // Validate addresses
        if (_escrowOperator == address(0)) revert InvalidAddress("escrowOperator");
        if (_payback == address(0)) revert InvalidAddress("payback");
        if (_recipient == address(0)) revert InvalidAddress("recipient");
        if (_feeRecipient == address(0)) revert InvalidAddress("feeRecipient");
        if (_gasTank == address(0)) revert InvalidAddress("gasTank");
        if (_dealID == bytes32(0)) revert InvalidAddress("dealID");

        // Set immutable state
        escrowOperator = _escrowOperator;
        dealID = _dealID;
        payback = _payback;
        recipient = _recipient;
        feeRecipient = _feeRecipient;
        gasTank = _gasTank;
        currency = _currency;
        swapValue = _swapValue;
        feeValue = _feeValue;

        // Initialize to COLLECTION state
        state = State.COLLECTION;
        _swapExecuted = false;
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute swap: transfer funds to recipient, pay fees, refund surplus
     * @dev CRITICAL: Can only be called once. State: COLLECTION -> SWAP -> COMPLETED
     * @dev Checks-Effects-Interactions pattern for reentrancy safety
     */
    function swap() external onlyOperator inState(State.COLLECTION) nonReentrant {
        // CHECKS: Verify balance meets requirements
        if (!canSwap()) {
            revert InsufficientBalance(
                swapValue + feeValue,
                _getBalance(currency)
            );
        }

        // CRITICAL: Prevent double-swap
        if (_swapExecuted) revert AlreadyExecuted();

        // EFFECTS: Update state before external calls
        _transitionState(State.SWAP);
        _swapExecuted = true;

        // INTERACTIONS: Execute transfers atomically
        _swap();
        _payFees();
        _refund();

        // EFFECTS: Final state transition
        _transitionState(State.COMPLETED);
        emit SwapExecuted(recipient, swapValue, feeValue);
    }

    /**
     * @notice Revert escrow: pay fees and refund all remaining funds
     * @dev State: COLLECTION -> REVERTED
     */
    function revertEscrow() external onlyOperator inState(State.COLLECTION) nonReentrant {
        // EFFECTS: Update state before external calls
        _transitionState(State.REVERTED);

        // INTERACTIONS: Execute transfers
        _payFees();
        _refund();

        emit Reverted(payback, _getBalance(currency));
    }

    /**
     * @notice Refund remaining balance to payback address
     * @dev Can be called publicly in COMPLETED or REVERTED state
     */
    function refund() external inStates(State.COMPLETED, State.REVERTED) nonReentrant {
        _refund();
    }

    /**
     * @notice Sweep non-swap currency to gasTank
     * @dev Can be called publicly in COMPLETED or REVERTED state
     * @param _currency Token to sweep (must not be swap currency)
     */
    function sweep(address _currency) external inStates(State.COMPLETED, State.REVERTED) nonReentrant {
        if (_currency == currency) revert InvalidCurrency(_currency);
        _sweep(_currency);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Check if balance meets swap requirements
     * @return true if balance >= swapValue + feeValue
     */
    function canSwap() public view returns (bool) {
        uint256 balance = _getBalance(currency);
        uint256 required = swapValue + feeValue;
        return balance >= required;
    }

    /**
     * @notice Get current balance in swap currency
     * @return Current balance
     */
    function getBalance() external view returns (uint256) {
        return _getBalance(currency);
    }

    /**
     * @notice Check if swap has been executed
     * @return true if swap was executed
     */
    function isSwapExecuted() external view returns (bool) {
        return _swapExecuted;
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Internal: Validate and execute state transition with guardrails
     * @dev Enforces valid state machine transitions only:
     *      - COLLECTION -> SWAP (during swap execution)
     *      - COLLECTION -> REVERTED (during revert)
     *      - SWAP -> COMPLETED (after swap completes)
     * @param to Target state to transition to
     */
    function _transitionState(State to) internal {
        State from = state;

        // Validate transition is allowed
        bool validTransition = false;

        if (from == State.COLLECTION) {
            // From COLLECTION: can go to SWAP or REVERTED only
            validTransition = (to == State.SWAP || to == State.REVERTED);
        } else if (from == State.SWAP) {
            // From SWAP: can only go to COMPLETED
            validTransition = (to == State.COMPLETED);
        }
        // From COMPLETED or REVERTED: no transitions allowed (terminal states)

        if (!validTransition) {
            revert InvalidStateTransition(from, to);
        }

        // Execute transition
        state = to;
        emit StateTransition(from, to);
    }

    /**
     * @notice Internal: Transfer swapValue to recipient
     * @dev Must only be called once during swap()
     */
    function _swap() internal {
        if (swapValue > 0) {
            _transfer(currency, recipient, swapValue);
        }
    }

    /**
     * @notice Internal: Transfer feeValue to feeRecipient
     */
    function _payFees() internal {
        if (feeValue > 0) {
            _transfer(currency, feeRecipient, feeValue);
        }
    }

    /**
     * @notice Internal: Transfer remaining balance to payback
     */
    function _refund() internal {
        uint256 balance = _getBalance(currency);
        if (balance > 0) {
            _transfer(currency, payback, balance);
            emit Refunded(payback, balance);
        }
    }

    /**
     * @notice Internal: Sweep currency to gasTank
     * @param _currency Token to sweep
     */
    function _sweep(address _currency) internal {
        uint256 balance = _getBalance(_currency);
        if (balance > 0) {
            _transfer(_currency, gasTank, balance);
            emit Swept(_currency, gasTank, balance);
        }
    }

    /**
     * @notice Internal: Safe transfer supporting both native and ERC20
     * @param token Token address (address(0) for native)
     * @param to Recipient address
     * @param amount Amount to transfer
     */
    function _transfer(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            // Native currency transfer
            (bool success, ) = to.call{value: amount}("");
            if (!success) revert TransferFailed(token, to, amount);
        } else {
            // ERC20 transfer using SafeERC20
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /**
     * @notice Internal: Get balance supporting both native and ERC20
     * @param token Token address (address(0) for native)
     * @return Current balance
     */
    function _getBalance(address token) internal view returns (uint256) {
        if (token == address(0)) {
            return address(this).balance;
        } else {
            return IERC20(token).balanceOf(address(this));
        }
    }

    /*//////////////////////////////////////////////////////////////
                          RECEIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Accept native currency deposits
     */
    receive() external payable {}

    /**
     * @notice Fallback for native currency deposits
     */
    fallback() external payable {}
}
