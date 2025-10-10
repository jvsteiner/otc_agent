// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title UnicitySwapEscrowImplementationArray
 * @notice EXPERIMENTAL: Array storage version for gas comparison
 * @dev Uses bytes32[5] array instead of 5 named storage variables
 *
 * STORAGE LAYOUT:
 * _data[0] = payback address (20 bytes cast to bytes32)
 * _data[1] = recipient address (20 bytes cast to bytes32)
 * _data[2] = currency address (20 bytes cast to bytes32)
 * _data[3] = swapValue (uint256 as bytes32)
 * _data[4] = feeValue (uint256 as bytes32)
 * _state = State enum (separate variable)
 * _swapExecuted = bool (separate variable)
 *
 * Total: 5 bytes32 slots + 2 small variables (should pack into 1 slot) = 6 slots
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrowImplementationArray is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                        HARDCODED CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Backend operator address - MUST BE CONFIGURED BEFORE DEPLOYMENT
    address internal constant ESCROW_OPERATOR = 0x0000000000000000000000000000000000000001; // TODO: REPLACE WITH REAL ADDRESS

    /// @notice Fee recipient address - MUST BE CONFIGURED BEFORE DEPLOYMENT
    address payable internal constant FEE_RECIPIENT = payable(0x0000000000000000000000000000000000000002); // TODO: REPLACE WITH REAL ADDRESS

    /// @notice Gas tank address - MUST BE CONFIGURED BEFORE DEPLOYMENT
    address payable internal constant GAS_TANK = payable(0x0000000000000000000000000000000000000003); // TODO: REPLACE WITH REAL ADDRESS

    /// @notice Fee basis points (0.3% = 30 BPS)
    uint256 internal constant FEE_BPS = 30;

    /*//////////////////////////////////////////////////////////////
                                 ENUMS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Escrow state machine
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
                    ARRAY STORAGE (EXPERIMENTAL)
    //////////////////////////////////////////////////////////////*/

    /// @notice Simple array storage: 5 bytes32 slots
    bytes32[5] private _data;

    /// @notice Separate state and flag (should pack into 1 slot)
    State private _state;
    bool private _swapExecuted;

    /*//////////////////////////////////////////////////////////////
                        INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    function _getPayback() internal view returns (address payable) {
        return payable(address(uint160(uint256(_data[0]))));
    }

    function _getRecipient() internal view returns (address payable) {
        return payable(address(uint160(uint256(_data[1]))));
    }

    function _getCurrency() internal view returns (address) {
        return address(uint160(uint256(_data[2])));
    }

    function _getSwapValue() internal view returns (uint256) {
        return uint256(_data[3]);
    }

    function _getFeeValue() internal view returns (uint256) {
        return uint256(_data[4]);
    }

    function _setPayback(address payable addr) internal {
        _data[0] = bytes32(uint256(uint160(address(addr))));
    }

    function _setRecipient(address payable addr) internal {
        _data[1] = bytes32(uint256(uint160(address(addr))));
    }

    function _setCurrency(address addr) internal {
        _data[2] = bytes32(uint256(uint160(addr)));
    }

    function _setSwapValue(uint256 value) internal {
        _data[3] = bytes32(value);
    }

    function _setFeeValue(uint256 value) internal {
        _data[4] = bytes32(value);
    }

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
        if (uint256(_data[0]) == 0) revert NotInitialized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize escrow with parameters (replaces constructor for proxy pattern)
     */
    function initialize(
        address payable payback_,
        address payable recipient_,
        address currency_,
        uint256 swapValue_,
        uint256 feeValue_
    ) external {
        // Prevent re-initialization
        if (uint256(_data[0]) != 0) revert AlreadyInitialized();

        // Validate addresses
        if (payback_ == address(0)) revert InvalidAddress("payback");
        if (recipient_ == address(0)) revert InvalidAddress("recipient");

        // Set array storage
        _setPayback(payback_);
        _setRecipient(recipient_);
        _setCurrency(currency_);
        _setSwapValue(swapValue_);
        _setFeeValue(feeValue_);
        _state = State.COLLECTION;
        _swapExecuted = false;

        emit Initialized(dealID(), payback_, recipient_);
    }

    /*//////////////////////////////////////////////////////////////
                          COMPUTED PROPERTIES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Compute unique deal ID from escrow address and chain ID
     */
    function dealID() public view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), block.chainid));
    }

    /**
     * @notice Get fee value
     */
    function feeValue() public view whenInitialized returns (uint256) {
        return _getFeeValue();
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function escrowOperator() external pure returns (address) {
        return ESCROW_OPERATOR;
    }

    function payback() external view whenInitialized returns (address payable) {
        return _getPayback();
    }

    function recipient() external view whenInitialized returns (address payable) {
        return _getRecipient();
    }

    function feeRecipient() external pure returns (address payable) {
        return FEE_RECIPIENT;
    }

    function gasTank() external pure returns (address payable) {
        return GAS_TANK;
    }

    function currency() external view whenInitialized returns (address) {
        return _getCurrency();
    }

    function swapValue() external view whenInitialized returns (uint256) {
        return _getSwapValue();
    }

    function state() external view whenInitialized returns (State) {
        return _state;
    }

    function isSwapExecuted() external view whenInitialized returns (bool) {
        return _swapExecuted;
    }

    /**
     * @notice Check if balance meets swap requirements
     */
    function canSwap() public view whenInitialized returns (bool) {
        uint256 balance = _getBalance(_getCurrency());
        uint256 required = _getSwapValue() + _getFeeValue();
        return balance >= required;
    }

    /**
     * @notice Get current balance in swap currency
     */
    function getBalance() external view whenInitialized returns (uint256) {
        return _getBalance(_getCurrency());
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute swap: transfer funds to recipient, pay fees, refund surplus
     */
    function swap() external onlyOperator inState(State.COLLECTION) nonReentrant whenInitialized {
        // CHECKS: Verify balance meets requirements
        uint256 feeVal = _getFeeValue();
        address currencyAddr = _getCurrency();
        uint256 swapVal = _getSwapValue();

        if (!canSwap()) {
            revert InsufficientBalance(
                swapVal + feeVal,
                _getBalance(currencyAddr)
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
        emit SwapExecuted(_getRecipient(), swapVal, feeVal);
    }

    /**
     * @notice Revert escrow: pay fees and refund all remaining funds
     */
    function revertEscrow() external onlyOperator inState(State.COLLECTION) nonReentrant whenInitialized {
        // EFFECTS: Update state before external calls
        _transitionState(State.REVERTED);

        // INTERACTIONS: Execute transfers
        _payFees(_getFeeValue());
        _refund();

        emit Reverted(_getPayback(), _getBalance(_getCurrency()));
    }

    /**
     * @notice Refund remaining balance to payback address
     */
    function refund() external inStates(State.COMPLETED, State.REVERTED) nonReentrant whenInitialized {
        _refund();
    }

    /**
     * @notice Sweep non-swap currency to gasTank
     */
    function sweep(address currency_) external inStates(State.COMPLETED, State.REVERTED) nonReentrant whenInitialized {
        address swapCurrency = _getCurrency();
        if (currency_ == swapCurrency) revert InvalidCurrency(currency_);
        _sweep(currency_);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Internal: Validate and execute state transition
     */
    function _transitionState(State to) internal {
        State from = _state;

        // Validate transition is allowed
        bool validTransition = false;

        if (from == State.COLLECTION) {
            validTransition = (to == State.SWAP || to == State.REVERTED);
        } else if (from == State.SWAP) {
            validTransition = (to == State.COMPLETED);
        }

        if (!validTransition) {
            revert InvalidStateTransition(from, to);
        }

        // Execute transition
        _state = to;
        emit StateTransition(from, to);
    }

    /**
     * @notice Internal: Transfer swapValue to recipient
     */
    function _swap() internal {
        uint256 swapVal = _getSwapValue();
        if (swapVal > 0) {
            _transfer(_getCurrency(), _getRecipient(), swapVal);
        }
    }

    /**
     * @notice Internal: Transfer feeValue to feeRecipient
     */
    function _payFees(uint256 feeVal) internal {
        if (feeVal > 0) {
            _transfer(_getCurrency(), FEE_RECIPIENT, feeVal);
        }
    }

    /**
     * @notice Internal: Transfer remaining balance to payback
     */
    function _refund() internal {
        address currencyAddr = _getCurrency();
        uint256 balance = _getBalance(currencyAddr);
        if (balance > 0) {
            _transfer(currencyAddr, _getPayback(), balance);
            emit Refunded(_getPayback(), balance);
        }
    }

    /**
     * @notice Internal: Sweep currency to gasTank
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
