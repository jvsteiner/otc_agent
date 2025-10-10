// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title UnicitySwapEscrowImplementation
 * @notice Gas-optimized beacon-proxy implementation for OTC cross-chain swaps
 * @dev Implements state machine: COLLECTION -> SWAP -> COMPLETED or COLLECTION -> REVERTED
 *
 * GAS OPTIMIZATIONS:
 * - Hardcoded constants (operator, fee recipient, gas tank addresses)
 * - Minimal storage: 4 slots only (packed efficiently)
 * - Computed values: dealID derived from address+chainid, feeValue calculated dynamically
 * - Beacon-proxy pattern: minimal deployment bytecode
 *
 * STORAGE LAYOUT (4 slots):
 * Slot 0: payback (20 bytes) | state (1 byte) | swapExecuted (1 byte) | padding (10 bytes)
 * Slot 1: recipient (20 bytes)
 * Slot 2: currency (20 bytes)
 * Slot 3: swapValue (32 bytes)
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * - State transitions are atomic and irreversible
 * - SWAP state can only be entered once (prevents double-swap)
 * - Re-entrancy protection on all state-changing functions
 * - Safe ERC20 transfers with proper error handling
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrowImplementation is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                        HARDCODED CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Backend operator address - MUST BE CONFIGURED BEFORE DEPLOYMENT
    /// @dev This is the address that will call swap() and revertEscrow()
    address internal constant ESCROW_OPERATOR = 0x0000000000000000000000000000000000000001; // TODO: REPLACE WITH REAL ADDRESS

    /// @notice Fee recipient address - MUST BE CONFIGURED BEFORE DEPLOYMENT
    /// @dev This is where commission fees are sent
    address payable internal constant FEE_RECIPIENT = payable(0x0000000000000000000000000000000000000002); // TODO: REPLACE WITH REAL ADDRESS

    /// @notice Gas tank address - MUST BE CONFIGURED BEFORE DEPLOYMENT
    /// @dev This is where leftover assets are swept
    address payable internal constant GAS_TANK = payable(0x0000000000000000000000000000000000000003); // TODO: REPLACE WITH REAL ADDRESS

    /// @notice Fee basis points (0.3% = 30 BPS)
    uint256 internal constant FEE_BPS = 30;

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
    event Initialized(bytes32 indexed dealID, address indexed payback, address indexed recipient);

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
    error AlreadyInitialized();
    error NotInitialized();

    /*//////////////////////////////////////////////////////////////
                        MINIMAL STORAGE (4 SLOTS)
    //////////////////////////////////////////////////////////////*/

    /// @notice Packed storage slot 0: payback (20 bytes) + state (1 byte) + swapExecuted (1 byte)
    address payable private _payback;
    State private _state;
    bool private _swapExecuted;

    /// @notice Storage slot 1: recipient address
    address payable private _recipient;

    /// @notice Storage slot 2: currency address
    address private _currency;

    /// @notice Storage slot 3: swap value
    uint256 private _swapValue;

    /// @notice Storage slot 4: fee value
    uint256 private _feeValue;

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOperator() {
        if (msg.sender != ESCROW_OPERATOR) revert UnauthorizedOperator();
        _;
    }

    modifier inState(State required) {
        if (_state != required) revert InvalidState(_state, required);
        _;
    }

    modifier inStates(State required1, State required2) {
        if (_state != required1 && _state != required2) {
            revert InvalidStateMultiple(_state, required1, required2);
        }
        _;
    }

    modifier whenInitialized() {
        if (_payback == address(0)) revert NotInitialized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize escrow with parameters (replaces constructor for proxy pattern)
     * @dev Can only be called once. MUST be called immediately after proxy deployment
     * @param payback_ Refund address for remaining balance
     * @param recipient_ Swap recipient address
     * @param currency_ ERC20 token (address(0) for native)
     * @param swapValue_ Required balance to execute swap
     * @param feeValue_ Operator fee amount (calculated off-chain based on commission mode)
     */
    function initialize(
        address payable payback_,
        address payable recipient_,
        address currency_,
        uint256 swapValue_,
        uint256 feeValue_
    ) external {
        // Prevent re-initialization
        if (_payback != address(0)) revert AlreadyInitialized();

        // Validate addresses
        if (payback_ == address(0)) revert InvalidAddress("payback");
        if (recipient_ == address(0)) revert InvalidAddress("recipient");

        // Set storage
        _payback = payback_;
        _recipient = recipient_;
        _currency = currency_;
        _swapValue = swapValue_;
        _feeValue = feeValue_;
        _state = State.COLLECTION;
        _swapExecuted = false;

        emit Initialized(dealID(), payback_, recipient_);
    }

    /*//////////////////////////////////////////////////////////////
                          COMPUTED PROPERTIES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Compute unique deal ID from escrow address and chain ID
     * @dev Uses escrow address as deterministic identifier
     * @return Unique deal identifier
     */
    function dealID() public view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), block.chainid));
    }

    /**
     * @notice Get fee value
     * @dev Stored in slot 4, calculated off-chain based on commission mode
     * @return Operator fee amount
     */
    function feeValue() public view whenInitialized returns (uint256) {
        return _feeValue;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function escrowOperator() external pure returns (address) {
        return ESCROW_OPERATOR;
    }

    function payback() external view whenInitialized returns (address payable) {
        return _payback;
    }

    function recipient() external view whenInitialized returns (address payable) {
        return _recipient;
    }

    function feeRecipient() external pure returns (address payable) {
        return FEE_RECIPIENT;
    }

    function gasTank() external pure returns (address payable) {
        return GAS_TANK;
    }

    function currency() external view whenInitialized returns (address) {
        return _currency;
    }

    function swapValue() external view whenInitialized returns (uint256) {
        return _swapValue;
    }

    function state() external view whenInitialized returns (State) {
        return _state;
    }

    function isSwapExecuted() external view whenInitialized returns (bool) {
        return _swapExecuted;
    }

    /**
     * @notice Check if balance meets swap requirements
     * @return true if balance >= swapValue + feeValue
     */
    function canSwap() public view whenInitialized returns (bool) {
        uint256 balance = _getBalance(_currency);
        uint256 required = _swapValue + feeValue();
        return balance >= required;
    }

    /**
     * @notice Get current balance in swap currency
     * @return Current balance
     */
    function getBalance() external view whenInitialized returns (uint256) {
        return _getBalance(_currency);
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute swap: transfer funds to recipient, pay fees, refund surplus
     * @dev CRITICAL: Can only be called once. State: COLLECTION -> SWAP -> COMPLETED
     * @dev Checks-Effects-Interactions pattern for reentrancy safety
     */
    function swap() external onlyOperator inState(State.COLLECTION) nonReentrant whenInitialized {
        // CHECKS: Verify balance meets requirements
        uint256 feeVal = feeValue();
        if (!canSwap()) {
            revert InsufficientBalance(
                _swapValue + feeVal,
                _getBalance(_currency)
            );
        }

        // CRITICAL: Prevent double-swap
        if (_swapExecuted) revert AlreadyExecuted();

        // EFFECTS: Update state before external calls
        _transitionState(State.SWAP);
        _swapExecuted = true;

        // INTERACTIONS: Execute transfers atomically
        _swap();
        _payFees(feeVal);
        _refund();

        // EFFECTS: Final state transition
        _transitionState(State.COMPLETED);
        emit SwapExecuted(_recipient, _swapValue, feeVal);
    }

    /**
     * @notice Revert escrow: pay fees and refund all remaining funds
     * @dev State: COLLECTION -> REVERTED
     */
    function revertEscrow() external onlyOperator inState(State.COLLECTION) nonReentrant whenInitialized {
        // EFFECTS: Update state before external calls
        _transitionState(State.REVERTED);

        // INTERACTIONS: Execute transfers
        _payFees(feeValue());
        _refund();

        emit Reverted(_payback, _getBalance(_currency));
    }

    /**
     * @notice Refund remaining balance to payback address
     * @dev Can be called publicly in COMPLETED or REVERTED state
     */
    function refund() external inStates(State.COMPLETED, State.REVERTED) nonReentrant whenInitialized {
        _refund();
    }

    /**
     * @notice Sweep non-swap currency to gasTank
     * @dev Can be called publicly in COMPLETED or REVERTED state
     * @param currency_ Token to sweep (must not be swap currency)
     */
    function sweep(address currency_) external inStates(State.COMPLETED, State.REVERTED) nonReentrant whenInitialized {
        if (currency_ == _currency) revert InvalidCurrency(currency_);
        _sweep(currency_);
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
        State from = _state;

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
        _state = to;
        emit StateTransition(from, to);
    }

    /**
     * @notice Internal: Transfer swapValue to recipient
     * @dev Must only be called once during swap()
     */
    function _swap() internal {
        if (_swapValue > 0) {
            _transfer(_currency, _recipient, _swapValue);
        }
    }

    /**
     * @notice Internal: Transfer feeValue to feeRecipient
     */
    function _payFees(uint256 feeVal) internal {
        if (feeVal > 0) {
            _transfer(_currency, FEE_RECIPIENT, feeVal);
        }
    }

    /**
     * @notice Internal: Transfer remaining balance to payback
     */
    function _refund() internal {
        uint256 balance = _getBalance(_currency);
        if (balance > 0) {
            _transfer(_currency, _payback, balance);
            emit Refunded(_payback, balance);
        }
    }

    /**
     * @notice Internal: Sweep currency to gasTank
     * @param currency_ Token to sweep
     */
    function _sweep(address currency_) internal {
        uint256 balance = _getBalance(currency_);
        if (balance > 0) {
            _transfer(currency_, GAS_TANK, balance);
            emit Swept(currency_, GAS_TANK, balance);
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
