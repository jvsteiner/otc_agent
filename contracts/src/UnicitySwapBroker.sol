// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title UnicitySwapBroker
 * @notice Stateless broker contract for atomic OTC swap execution
 * @dev Single contract instance handles all deals. Replaces per-deal escrow deployment.
 *
 * ARCHITECTURE:
 * - Stateless design: no per-deal storage except dealId tracking
 * - Atomic execution: swap/revert in single transaction
 * - For native swaps: receives msg.value, distributes atomically
 * - For ERC20 swaps: transferFrom escrow (requires pre-approval), distributes atomically
 * - Direct transfers: ERC20 tokens are transferred directly from escrow to recipients (gas optimized)
 *
 * SECURITY GUARANTEES:
 * - Each dealId can only be processed once (prevents double-execution)
 * - Only operator can execute swap/revert functions
 * - Re-entrancy protection on all state-changing functions
 * - Safe ERC20 transfers with proper error handling
 * - Validates all addresses and amounts before execution
 *
 * TOKEN COMPATIBILITY:
 * - ✅ Standard ERC20 tokens (USDT, USDC, DAI, etc.)
 * - ✅ Native currencies (ETH, MATIC, etc.)
 * - ❌ Fee-on-transfer tokens NOT supported (e.g., Safemoon, RFI)
 * - ❌ Rebasing tokens NOT supported (e.g., stETH, aTokens)
 * Users are responsible for understanding token mechanics before trading.
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapBroker is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Emitted when swap is executed successfully
     * @param dealId Unique deal identifier
     * @param currency Token address (address(0) for native)
     * @param recipient Swap recipient address
     * @param feeRecipient Fee recipient address
     * @param payback Refund recipient address
     * @param swapAmount Amount transferred to recipient
     * @param feeAmount Fee amount transferred to feeRecipient
     * @param refundAmount Surplus transferred to payback
     */
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

    /**
     * @notice Emitted when revert is executed successfully
     * @param dealId Unique deal identifier
     * @param currency Token address (address(0) for native)
     * @param feeRecipient Fee recipient address
     * @param payback Refund recipient address
     * @param feeAmount Fee amount transferred to feeRecipient
     * @param refundAmount Amount transferred to payback
     */
    event RevertExecuted(
        bytes32 indexed dealId,
        address indexed currency,
        address feeRecipient,
        address payback,
        uint256 feeAmount,
        uint256 refundAmount
    );

    /**
     * @notice Emitted when operator is updated
     * @param oldOperator Previous operator address
     * @param newOperator New operator address
     */
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error UnauthorizedOperator();
    error DealAlreadyProcessed(bytes32 dealId);
    error InvalidAddress(string param);
    error InvalidAmount(string param);
    error InsufficientBalance(uint256 required, uint256 available);
    error TransferFailed(address token, address to, uint256 amount);
    error InvalidEscrowAddress();

    /*//////////////////////////////////////////////////////////////
                            STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Operator authorized to trigger swap/revert
    address public operator;

    /// @notice Tracks processed deals to prevent double-execution
    /// @dev dealId => true if processed (swap or revert executed)
    mapping(bytes32 => bool) public processedDeals;

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOperator() {
        if (msg.sender != operator) revert UnauthorizedOperator();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize broker with operator address
     * @param _operator Address authorized to trigger swap/revert
     */
    constructor(address _operator) Ownable(msg.sender) {
        if (_operator == address(0)) revert InvalidAddress("operator");
        operator = _operator;
    }

    /*//////////////////////////////////////////////////////////////
                          OPERATOR MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update operator address (only owner)
     * @param newOperator New operator address
     */
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress("newOperator");
        address oldOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(oldOperator, newOperator);
    }

    /*//////////////////////////////////////////////////////////////
                          SWAP FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute native currency swap
     * @dev CRITICAL: Can only be called once per dealId
     * @dev Receives native currency via msg.value, distributes atomically
     * @param dealId Unique deal identifier
     * @param payback Address to receive surplus funds
     * @param recipient Address to receive swap amount
     * @param feeRecipient Address to receive fee
     * @param amount Swap amount to transfer to recipient
     * @param fees Fee amount to transfer to feeRecipient
     */
    function swapNative(
        bytes32 dealId,
        address payable payback,
        address payable recipient,
        address payable feeRecipient,
        uint256 amount,
        uint256 fees
    ) external payable onlyOperator nonReentrant {
        _swap(address(0), dealId, address(0), payback, recipient, feeRecipient, amount, fees);
    }

    /**
     * @notice Execute ERC20 token swap
     * @dev CRITICAL: Can only be called once per dealId
     * @dev Pulls tokens from msg.sender (escrow must approve broker first)
     * @param currency ERC20 token address
     * @param dealId Unique deal identifier
     * @param escrow Escrow address that holds the tokens (caller must be operator, tokens pulled from escrow)
     * @param payback Address to receive surplus funds
     * @param recipient Address to receive swap amount
     * @param feeRecipient Address to receive fee
     * @param amount Swap amount to transfer to recipient
     * @param fees Fee amount to transfer to feeRecipient
     */
    function swapERC20(
        address currency,
        bytes32 dealId,
        address escrow,
        address payable payback,
        address payable recipient,
        address payable feeRecipient,
        uint256 amount,
        uint256 fees
    ) external onlyOperator nonReentrant {
        if (currency == address(0)) revert InvalidAddress("currency");
        if (escrow == address(0)) revert InvalidEscrowAddress();
        _swap(currency, dealId, escrow, payback, recipient, feeRecipient, amount, fees);
    }

    /*//////////////////////////////////////////////////////////////
                          REVERT FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Revert native currency deal
     * @dev CRITICAL: Can only be called once per dealId
     * @dev Receives native currency via msg.value, pays fees and refunds remainder
     * @param dealId Unique deal identifier
     * @param payback Address to receive refund
     * @param feeRecipient Address to receive fee
     * @param fees Fee amount to transfer to feeRecipient
     */
    function revertNative(
        bytes32 dealId,
        address payable payback,
        address payable feeRecipient,
        uint256 fees
    ) external payable onlyOperator nonReentrant {
        _revert(address(0), dealId, address(0), payback, feeRecipient, fees);
    }

    /**
     * @notice Revert ERC20 token deal
     * @dev CRITICAL: Can only be called once per dealId
     * @dev Pulls tokens from msg.sender (escrow must approve broker first)
     * @param currency ERC20 token address
     * @param dealId Unique deal identifier
     * @param escrow Escrow address that holds the tokens (caller must be operator, tokens pulled from escrow)
     * @param payback Address to receive refund
     * @param feeRecipient Address to receive fee
     * @param fees Fee amount to transfer to feeRecipient
     */
    function revertERC20(
        address currency,
        bytes32 dealId,
        address escrow,
        address payable payback,
        address payable feeRecipient,
        uint256 fees
    ) external onlyOperator nonReentrant {
        if (escrow == address(0)) revert InvalidEscrowAddress();
        _revert(currency, dealId, escrow, payback, feeRecipient, fees);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Mark deal as executed, preventing double-execution
     * @dev MUST be called at the start of _swap and _revert (after validation, before any transfers)
     * @param dealId Unique deal identifier to mark as processed
     */
    function _markDealAsExecuted(bytes32 dealId) internal {
        // CHECKS: Verify deal hasn't been processed
        if (processedDeals[dealId]) revert DealAlreadyProcessed(dealId);

        // EFFECTS: Mark deal as processed before any external calls
        processedDeals[dealId] = true;
    }

    /**
     * @notice Internal: Execute swap (unified for native and ERC20)
     * @dev Checks-Effects-Interactions pattern for reentrancy safety
     * @param currency Token address (address(0) for native)
     * @param dealId Unique deal identifier
     * @param escrow Escrow address (address(0) for native, required for ERC20)
     * @param payback Refund recipient
     * @param recipient Swap recipient
     * @param feeRecipient Fee recipient
     * @param amount Swap amount
     * @param fees Fee amount
     */
    function _swap(
        address currency,
        bytes32 dealId,
        address escrow,
        address payable payback,
        address payable recipient,
        address payable feeRecipient,
        uint256 amount,
        uint256 fees
    ) internal {
        // CHECKS: Validate inputs
        if (dealId == bytes32(0)) revert InvalidAddress("dealId");
        if (payback == address(0)) revert InvalidAddress("payback");
        if (recipient == address(0)) revert InvalidAddress("recipient");
        if (feeRecipient == address(0)) revert InvalidAddress("feeRecipient");

        // EFFECTS: Mark deal as executed FIRST (prevents double-execution)
        _markDealAsExecuted(dealId);

        if (currency == address(0)) {
            // Native currency swap
            uint256 totalRequired = amount + fees;
            if (msg.value < totalRequired) {
                revert InsufficientBalance(totalRequired, msg.value);
            }

            // INTERACTIONS: Execute transfers atomically
            if (amount > 0) {
                _transferNative(recipient, amount);
            }
            if (fees > 0) {
                _transferNative(feeRecipient, fees);
            }

            // Calculate and transfer refund
            unchecked {
                uint256 refundAmount = msg.value - amount - fees;
                if (refundAmount > 0) {
                    _transferNative(payback, refundAmount);
                }
                emit SwapExecuted(dealId, currency, recipient, feeRecipient, payback, amount, fees, refundAmount);
            }
        } else {
            // ERC20 token swap - direct transfers from escrow to recipients
            IERC20 token = IERC20(currency);
            uint256 totalRequired = amount + fees;

            // Check escrow balance
            uint256 escrowBalance = token.balanceOf(escrow);
            if (escrowBalance < totalRequired) {
                revert InsufficientBalance(totalRequired, escrowBalance);
            }

            // INTERACTIONS: Transfer directly from escrow to each recipient
            // This saves gas by eliminating intermediate transfer to broker
            if (amount > 0) {
                token.safeTransferFrom(escrow, recipient, amount);
            }
            if (fees > 0) {
                token.safeTransferFrom(escrow, feeRecipient, fees);
            }

            // Calculate and transfer refund (surplus) directly to payback
            unchecked {
                uint256 refundAmount = escrowBalance - amount - fees;
                if (refundAmount > 0) {
                    token.safeTransferFrom(escrow, payback, refundAmount);
                }
                emit SwapExecuted(dealId, currency, recipient, feeRecipient, payback, amount, fees, refundAmount);
            }
        }
    }

    /**
     * @notice Internal: Execute revert (unified for native and ERC20)
     * @dev Checks-Effects-Interactions pattern for reentrancy safety
     * @param currency Token address (address(0) for native)
     * @param dealId Unique deal identifier
     * @param escrow Escrow address (address(0) for native, required for ERC20)
     * @param payback Refund recipient
     * @param feeRecipient Fee recipient
     * @param fees Fee amount
     */
    function _revert(
        address currency,
        bytes32 dealId,
        address escrow,
        address payable payback,
        address payable feeRecipient,
        uint256 fees
    ) internal {
        // CHECKS: Validate inputs
        if (dealId == bytes32(0)) revert InvalidAddress("dealId");
        if (payback == address(0)) revert InvalidAddress("payback");
        if (feeRecipient == address(0)) revert InvalidAddress("feeRecipient");

        // EFFECTS: Mark deal as executed FIRST (prevents double-execution)
        _markDealAsExecuted(dealId);

        if (currency == address(0)) {
            // Native currency revert
            if (msg.value < fees) {
                revert InsufficientBalance(fees, msg.value);
            }

            // INTERACTIONS: Execute transfers atomically
            if (fees > 0) {
                _transferNative(feeRecipient, fees);
            }

            // Calculate and transfer refund
            unchecked {
                uint256 refundAmount = msg.value - fees;
                if (refundAmount > 0) {
                    _transferNative(payback, refundAmount);
                }
                emit RevertExecuted(dealId, currency, feeRecipient, payback, fees, refundAmount);
            }
        } else {
            // ERC20 token revert - direct transfers from escrow to recipients
            IERC20 token = IERC20(currency);

            // Check escrow balance
            uint256 escrowBalance = token.balanceOf(escrow);
            if (escrowBalance < fees) {
                revert InsufficientBalance(fees, escrowBalance);
            }

            // INTERACTIONS: Transfer directly from escrow to each recipient
            // This saves gas by eliminating intermediate transfer to broker
            if (fees > 0) {
                token.safeTransferFrom(escrow, feeRecipient, fees);
            }

            // Calculate and transfer refund (remainder) directly to payback
            unchecked {
                uint256 refundAmount = escrowBalance - fees;
                if (refundAmount > 0) {
                    token.safeTransferFrom(escrow, payback, refundAmount);
                }
                emit RevertExecuted(dealId, currency, feeRecipient, payback, fees, refundAmount);
            }
        }
    }

    /**
     * @notice Internal: Safe native currency transfer
     * @param to Recipient address
     * @param amount Amount to transfer
     */
    function _transferNative(address to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert TransferFailed(address(0), to, amount);
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
