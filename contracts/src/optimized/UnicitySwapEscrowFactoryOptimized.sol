// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./UnicitySwapEscrowProxy.sol";
import "./UnicitySwapEscrowImplementationArray.sol";

/**
 * @title UnicitySwapEscrowFactoryOptimized
 * @notice Gas-optimized factory for creating beacon-proxy escrow instances
 * @dev Deploys minimal proxy contracts (~200 bytes) instead of full contracts (900k gas)
 *
 * ARRAY STORAGE OPTIMIZATION:
 * - Uses UnicitySwapEscrowImplementationArray for additional gas savings
 * - Array storage reduces gas costs by ~10-15% on initialization and swaps
 * - Single bytes32[5] array replaces 5 separate storage variables
 *
 * GAS OPTIMIZATION STRATEGY:
 * - One-time deployment: Implementation + Beacon (~3M gas total, paid once)
 * - Per-escrow deployment: Proxy + Initialize (~120k gas per escrow with array storage)
 * - Savings: ~780k gas per escrow (86% reduction)
 *
 * DEPLOYMENT FLOW:
 * 1. Deploy UnicitySwapEscrowImplementationArray (one-time)
 * 2. Deploy UnicitySwapEscrowBeacon pointing to implementation (one-time)
 * 3. Deploy UnicitySwapEscrowFactoryOptimized with beacon address (one-time)
 * 4. Call createEscrow() for each new deal (~120k gas each)
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrowFactoryOptimized {
    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Beacon contract address (points to implementation)
    address public immutable beacon;

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
    error InitializationFailed();
    error InvalidBeacon();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize factory with beacon address
     * @param beacon_ Address of the beacon contract
     */
    constructor(address beacon_) {
        if (beacon_ == address(0)) revert InvalidBeacon();
        beacon = beacon_;
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Create new escrow instance via beacon-proxy
     * @dev Deploys minimal proxy (~200 bytes) and initializes it
     *
     * @param payback Refund address for remaining balance
     * @param recipient Swap recipient address
     * @param currency ERC20 token (address(0) for native)
     * @param swapValue Required balance to execute swap
     * @param feeValue Operator fee amount (calculated off-chain)
     *
     * @return escrow Address of newly created proxy
     */
    function createEscrow(
        address payable payback,
        address payable recipient,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    ) external returns (address escrow) {
        // Deploy minimal proxy
        UnicitySwapEscrowProxy proxy = new UnicitySwapEscrowProxy(beacon);
        escrow = address(proxy);

        if (escrow == address(0)) revert DeploymentFailed();

        // Initialize proxy
        (bool success, ) = escrow.call(
            abi.encodeWithSignature(
                "initialize(address,address,address,uint256,uint256)",
                payback,
                recipient,
                currency,
                swapValue,
                feeValue
            )
        );

        if (!success) revert InitializationFailed();

        // Compute dealID for event (same as implementation's computation)
        bytes32 dealId = keccak256(abi.encodePacked(escrow, block.chainid));

        // Get operator address from implementation
        address operator = UnicitySwapEscrowImplementationArray(payable(escrow)).escrowOperator();

        emit EscrowCreated(
            escrow,
            dealId,
            operator,
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
     * @param payback Refund address for remaining balance
     * @param recipient Swap recipient address
     * @param currency ERC20 token (address(0) for native)
     * @param swapValue Required balance to execute swap
     * @param feeValue Operator fee amount (calculated off-chain)
     * @return escrow Address of newly created proxy
     */
    function createEscrow2(
        bytes32 salt,
        address payable payback,
        address payable recipient,
        address currency,
        uint256 swapValue,
        uint256 feeValue
    ) external returns (address escrow) {
        // Deploy with CREATE2 for deterministic address
        UnicitySwapEscrowProxy proxy = new UnicitySwapEscrowProxy{salt: salt}(beacon);
        escrow = address(proxy);

        if (escrow == address(0)) revert DeploymentFailed();

        // Initialize proxy
        (bool success, ) = escrow.call(
            abi.encodeWithSignature(
                "initialize(address,address,address,uint256,uint256)",
                payback,
                recipient,
                currency,
                swapValue,
                feeValue
            )
        );

        if (!success) revert InitializationFailed();

        // Compute dealID for event
        bytes32 dealId = keccak256(abi.encodePacked(escrow, block.chainid));

        // Get operator address from implementation
        address operator = UnicitySwapEscrowImplementationArray(payable(escrow)).escrowOperator();

        emit EscrowCreated(
            escrow,
            dealId,
            operator,
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
     * @return Predicted escrow address
     */
    function computeEscrowAddress(
        bytes32 salt
    ) external view returns (address) {
        bytes memory bytecode = abi.encodePacked(
            type(UnicitySwapEscrowProxy).creationCode,
            abi.encode(beacon)
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

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get implementation address from beacon
     * @return Address of the current implementation
     */
    function getImplementation() external view returns (address) {
        (bool success, bytes memory returndata) = beacon.staticcall(
            abi.encodeWithSignature("implementation()")
        );

        require(success, "Beacon call failed");
        return abi.decode(returndata, (address));
    }
}
