// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./UnicitySwapEscrow.sol";

/**
 * @title UnicitySwapEscrowFactory
 * @notice Factory for creating UnicitySwapEscrow instances
 * @dev Deploys new escrow contracts directly (not via proxy)
 *
 * Note: In this implementation, we use direct deployment instead of proxies
 * because each escrow has unique immutable parameters that are set in the constructor.
 * This is more gas-efficient and simpler than using initializable proxies.
 *
 * Benefits:
 * - Simple and secure
 * - No delegatecall complexity
 * - Each escrow is independent
 * - Immutable parameters for gas optimization
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrowFactory {
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event EscrowCreated(
        address indexed escrow,
        bytes32 indexed dealID,
        address indexed operator,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    );

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error DeploymentFailed();

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Create new UnicitySwapEscrow instance
     * @dev Deploys a new escrow contract with given parameters
     *
     * @param escrowOperator Address authorized to trigger swap/revert
     * @param dealID Unique deal identifier (must not exist)
     * @param payback Refund address for remaining balance
     * @param recipient Swap recipient address
     * @param feeRecipient Operator fee destination
     * @param gasTank Sweep destination for leftover assets
     * @param currency ERC20 token (address(0) for native)
     * @param swapValue Required balance to execute swap
     * @param feeValue Operator commission amount
     *
     * @return escrow Address of newly created escrow
     */
    function createEscrow(
        address escrowOperator,
        bytes32 dealID,
        address payable payback,
        address payable recipient,
        address payable feeRecipient,
        address payable gasTank,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    ) external returns (address escrow) {
        // Deploy new escrow
        UnicitySwapEscrow newEscrow = new UnicitySwapEscrow(
            escrowOperator,
            dealID,
            payback,
            recipient,
            feeRecipient,
            gasTank,
            currency,
            swapValue,
            feeValue
        );

        escrow = address(newEscrow);

        if (escrow == address(0)) revert DeploymentFailed();

        emit EscrowCreated(
            escrow,
            dealID,
            escrowOperator,
            currency,
            swapValue,
            feeValue
        );

        return escrow;
    }

    /**
     * @notice Create escrow with deterministic address using CREATE2
     * @dev Allows predictable escrow addresses for better UX
     * @param salt Salt for CREATE2 deployment
     * @param escrowOperator Address authorized to trigger swap/revert
     * @param dealID Unique deal identifier (must not exist)
     * @param payback Refund address for remaining balance
     * @param recipient Swap recipient address
     * @param feeRecipient Operator fee destination
     * @param gasTank Sweep destination for leftover assets
     * @param currency ERC20 token (address(0) for native)
     * @param swapValue Required balance to execute swap
     * @param feeValue Operator commission amount
     * @return escrow Address of newly created escrow
     */
    function createEscrow2(
        bytes32 salt,
        address escrowOperator,
        bytes32 dealID,
        address payable payback,
        address payable recipient,
        address payable feeRecipient,
        address payable gasTank,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    ) external returns (address escrow) {
        // Deploy with CREATE2 for deterministic address
        UnicitySwapEscrow newEscrow = new UnicitySwapEscrow{salt: salt}(
            escrowOperator,
            dealID,
            payback,
            recipient,
            feeRecipient,
            gasTank,
            currency,
            swapValue,
            feeValue
        );

        escrow = address(newEscrow);

        if (escrow == address(0)) revert DeploymentFailed();

        emit EscrowCreated(
            escrow,
            dealID,
            escrowOperator,
            currency,
            swapValue,
            feeValue
        );

        return escrow;
    }

    /**
     * @notice Compute CREATE2 address for escrow
     * @dev Useful for predicting escrow address before deployment
     * @param salt Salt for CREATE2 deployment
     * @param escrowOperator Address authorized to trigger swap/revert
     * @param dealID Unique deal identifier
     * @param payback Refund address for remaining balance
     * @param recipient Swap recipient address
     * @param feeRecipient Operator fee destination
     * @param gasTank Sweep destination for leftover assets
     * @param currency ERC20 token (address(0) for native)
     * @param swapValue Required balance to execute swap
     * @param feeValue Operator commission amount
     * @return Predicted escrow address
     */
    function computeEscrowAddress(
        bytes32 salt,
        address escrowOperator,
        bytes32 dealID,
        address payable payback,
        address payable recipient,
        address payable feeRecipient,
        address payable gasTank,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    ) external view returns (address) {
        bytes memory bytecode = abi.encodePacked(
            type(UnicitySwapEscrow).creationCode,
            abi.encode(
                escrowOperator,
                dealID,
                payback,
                recipient,
                feeRecipient,
                gasTank,
                currency,
                swapValue,
                feeValue
            )
        );

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(bytecode)
            )
        );

        return address(uint160(uint256(hash)));
    }
}
