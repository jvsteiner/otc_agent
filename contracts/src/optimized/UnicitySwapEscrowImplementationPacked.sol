// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title UnicitySwapEscrowImplementationPacked
 * @notice EXPERIMENTAL: Ultra-aggressive gas-optimized escrow using bytes32[3] packed storage
 * @dev Implements state machine: COLLECTION -> SWAP -> COMPLETED or COLLECTION -> REVERTED
 *
 * GAS OPTIMIZATIONS:
 * - Hardcoded constants (operator, fee recipient, gas tank addresses)
 * - PACKED STORAGE: 3 bytes32 slots only (96 bytes total)
 * - Computed values: dealID derived from address+chainid
 * - Beacon-proxy pattern: minimal deployment bytecode
 *
 * PACKED STORAGE LAYOUT (3 × 32-byte slots):
 *
 * _packedData[0] (32 bytes):
 *   Bytes [0-19]:   payback address (20 bytes)
 *   Bytes [20-31]:  swapValue as uint96 (12 bytes) - max 79 billion tokens
 *
 * _packedData[1] (32 bytes):
 *   Bytes [0-19]:   recipient address (20 bytes)
 *   Bytes [20-31]:  feeValue as uint96 (12 bytes) - max 79 billion tokens
 *
 * _packedData[2] (32 bytes):
 *   Bytes [0-19]:   currency address (20 bytes)
 *   Bytes [20]:     state (uint8, 1 byte)
 *   Bytes [21]:     swapExecuted (bool, 1 byte)
 *   Bytes [22-31]:  unused padding (10 bytes)
 *
 * TRADE-OFFS:
 * - Pro: ~40k gas saved on initialization (60k vs 100k)
 * - Con: ~1-2k gas overhead per operation due to bit manipulation
 * - Limitation: uint96 max values (79 billion tokens with 18 decimals)
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * - State transitions are atomic and irreversible
 * - SWAP state can only be entered once (prevents double-swap)
 * - Re-entrancy protection on all state-changing functions
 * - Safe ERC20 transfers with proper error handling
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrowImplementationPacked is ReentrancyGuard {
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
    error ValueTooLarge(string param);

    /*//////////////////////////////////////////////////////////////
                    PACKED STORAGE (3 × bytes32 = 96 bytes)
    //////////////////////////////////////////////////////////////*/

    /// @dev Packed storage array - see layout documentation above
    bytes32[3] private _packedData;

    /*//////////////////////////////////////////////////////////////
                        INTERNAL STORAGE ACCESSORS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Extract payback address from slot 0
     * @dev Bytes [0-19] of _packedData[0]
     */
    function _getPayback() internal view returns (address payable) {
        return payable(address(uint160(uint256(_packedData[0]))));
    }

    /**
     * @notice Set payback address in slot 0
     * @dev Preserves upper 96 bits (swapValue)
     */
    function _setPayback(address payable _payback) internal {
        bytes32 slot0 = _packedData[0];
        // Clear lower 160 bits and set new address
        slot0 = bytes32((uint256(slot0) & 0xFFFFFFFFFFFFFFFFFFFFFFFF0000000000000000000000000000000000000000) | uint256(uint160(address(_payback))));
        _packedData[0] = slot0;
    }

    /**
     * @notice Extract swapValue from slot 0
     * @dev Bytes [20-31] of _packedData[0] (uint96)
     */
    function _getSwapValue() internal view returns (uint256) {
        return uint256(uint96(uint256(_packedData[0]) >> 160));
    }

    /**
     * @notice Set swapValue in slot 0
     * @dev Preserves lower 160 bits (payback address)
     */
    function _setSwapValue(uint256 _swapValue) internal {
        if (_swapValue > type(uint96).max) revert ValueTooLarge("swapValue");
        bytes32 slot0 = _packedData[0];
        // Clear upper 96 bits and set new value
        slot0 = bytes32((uint256(slot0) & 0x00000000000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) | (uint256(_swapValue) << 160));
        _packedData[0] = slot0;
    }

    /**
     * @notice Extract recipient address from slot 1
     * @dev Bytes [0-19] of _packedData[1]
     */
    function _getRecipient() internal view returns (address payable) {
        return payable(address(uint160(uint256(_packedData[1]))));
    }

    /**
     * @notice Set recipient address in slot 1
     * @dev Preserves upper 96 bits (feeValue)
     */
    function _setRecipient(address payable _recipient) internal {
        bytes32 slot1 = _packedData[1];
        // Clear lower 160 bits and set new address
        slot1 = bytes32((uint256(slot1) & 0xFFFFFFFFFFFFFFFFFFFFFFFF0000000000000000000000000000000000000000) | uint256(uint160(address(_recipient))));
        _packedData[1] = slot1;
    }

    /**
     * @notice Extract feeValue from slot 1
     * @dev Bytes [20-31] of _packedData[1] (uint96)
     */
    function _getFeeValue() internal view returns (uint256) {
        return uint256(uint96(uint256(_packedData[1]) >> 160));
    }

    /**
     * @notice Set feeValue in slot 1
     * @dev Preserves lower 160 bits (recipient address)
     */
    function _setFeeValue(uint256 _feeValue) internal {
        if (_feeValue > type(uint96).max) revert ValueTooLarge("feeValue");
        bytes32 slot1 = _packedData[1];
        // Clear upper 96 bits and set new value
        slot1 = bytes32((uint256(slot1) & 0x00000000000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) | (uint256(_feeValue) << 160));
        _packedData[1] = slot1;
    }

    /**
     * @notice Extract currency address from slot 2
     * @dev Bytes [0-19] of _packedData[2]
     */
    function _getCurrency() internal view returns (address) {
        return address(uint160(uint256(_packedData[2])));
    }

    /**
     * @notice Set currency address in slot 2
     * @dev Preserves upper 96 bits (state + swapExecuted + padding)
     */
    function _setCurrency(address _currency) internal {
        bytes32 slot2 = _packedData[2];
        // Clear lower 160 bits and set new address
        slot2 = bytes32((uint256(slot2) & 0xFFFFFFFFFFFFFFFFFFFFFFFF0000000000000000000000000000000000000000) | uint256(uint160(_currency)));
        _packedData[2] = slot2;
    }

    /**
     * @notice Extract state from slot 2
     * @dev Byte [20] of _packedData[2] (uint8)
     */
    function _getState() internal view returns (State) {
        return State(uint8(uint256(_packedData[2]) >> 160));
    }

    /**
     * @notice Set state in slot 2
     * @dev Preserves all other bits in slot 2
     */
    function _setState(State _state) internal {
        bytes32 slot2 = _packedData[2];
        // Clear byte 20 (bits 160-167) and set new state
        // Mask: keep all bits except 160-167, clear that byte (0x00 in position 20)
        uint256 mask = ~uint256(0xFF << 160); // Invert mask for byte 20
        slot2 = bytes32((uint256(slot2) & mask) | (uint256(_state) << 160));
        _packedData[2] = slot2;
    }

    /**
     * @notice Extract swapExecuted flag from slot 2
     * @dev Byte [21] of _packedData[2] (bool as uint8)
     */
    function _getSwapExecuted() internal view returns (bool) {
        return uint8(uint256(_packedData[2]) >> 168) != 0;
    }

    /**
     * @notice Set swapExecuted flag in slot 2
     * @dev Preserves all other bits in slot 2
     */
    function _setSwapExecuted(bool _executed) internal {
        bytes32 slot2 = _packedData[2];
        // Clear byte 21 (bits 168-175) and set new value
        // Mask: keep bits 0-167 (42 F's) and 176-255 (20 F's), clear 168-175 (00)
        slot2 = bytes32((uint256(slot2) & 0xFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF) | (uint256(_executed ? 1 : 0) << 168));
        _packedData[2] = slot2;
    }

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOperator() {
        if (msg.sender != ESCROW_OPERATOR) revert UnauthorizedOperator();
        _;
    }

    modifier inState(State required) {
        if (_getState() != required) revert InvalidState(_getState(), required);
        _;
    }

    modifier inStates(State required1, State required2) {
        State current = _getState();
        if (current != required1 && current != required2) {
            revert InvalidStateMultiple(current, required1, required2);
        }
        _;
    }

    modifier whenInitialized() {
        if (_getPayback() == address(0)) revert NotInitialized();
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
     * @param swapValue_ Required balance to execute swap (max: uint96)
     * @param feeValue_ Operator fee amount (max: uint96)
     */
    function initialize(
        address payable payback_,
        address payable recipient_,
        address currency_,
        uint256 swapValue_,
        uint256 feeValue_
    ) external {
        // Prevent re-initialization
        if (_getPayback() != address(0)) revert AlreadyInitialized();

        // Validate addresses
        if (payback_ == address(0)) revert InvalidAddress("payback");
        if (recipient_ == address(0)) revert InvalidAddress("recipient");

        // Validate values fit in uint96
        if (swapValue_ > type(uint96).max) revert ValueTooLarge("swapValue");
        if (feeValue_ > type(uint96).max) revert ValueTooLarge("feeValue");

        // Pack slot 0: payback (160 bits) | swapValue (96 bits)
        _packedData[0] = bytes32(
            uint256(uint160(address(payback_))) |
            (uint256(swapValue_) << 160)
        );

        // Pack slot 1: recipient (160 bits) | feeValue (96 bits)
        _packedData[1] = bytes32(
            uint256(uint160(address(recipient_))) |
            (uint256(feeValue_) << 160)
        );

        // Pack slot 2: currency (160 bits) | state (8 bits) | swapExecuted (8 bits) | padding
        _packedData[2] = bytes32(
            uint256(uint160(currency_)) |
            (uint256(State.COLLECTION) << 160) |
            (uint256(0) << 168) // swapExecuted = false
        );

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

    function feeValue() external view whenInitialized returns (uint256) {
        return _getFeeValue();
    }

    function state() external view whenInitialized returns (State) {
        return _getState();
    }

    function isSwapExecuted() external view whenInitialized returns (bool) {
        return _getSwapExecuted();
    }

    /**
     * @notice Check if balance meets swap requirements
     * @return true if balance >= swapValue + feeValue
     */
    function canSwap() public view whenInitialized returns (bool) {
        uint256 balance = _getBalance(_getCurrency());
        uint256 required = _getSwapValue() + _getFeeValue();
        return balance >= required;
    }

    /**
     * @notice Get current balance in swap currency
     * @return Current balance
     */
    function getBalance() external view whenInitialized returns (uint256) {
        return _getBalance(_getCurrency());
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
        uint256 feeVal = _getFeeValue();
        uint256 swapVal = _getSwapValue();
        address curr = _getCurrency();

        if (!canSwap()) {
            revert InsufficientBalance(
                swapVal + feeVal,
                _getBalance(curr)
            );
        }

        // CRITICAL: Prevent double-swap
        if (_getSwapExecuted()) revert AlreadyExecuted();

        // EFFECTS: Update state before external calls
        _transitionState(State.SWAP);
        _setSwapExecuted(true);

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
     * @dev State: COLLECTION -> REVERTED
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
        if (currency_ == _getCurrency()) revert InvalidCurrency(currency_);
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
        State from = _getState();

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
        _setState(to);
        emit StateTransition(from, to);
    }

    /**
     * @notice Internal: Transfer swapValue to recipient
     * @dev Must only be called once during swap()
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
        address curr = _getCurrency();
        uint256 balance = _getBalance(curr);
        if (balance > 0) {
            address payable paybackAddr = _getPayback();
            _transfer(curr, paybackAddr, balance);
            emit Refunded(paybackAddr, balance);
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
