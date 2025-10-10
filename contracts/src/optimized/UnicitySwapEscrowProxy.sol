// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title UnicitySwapEscrowProxy
 * @notice Minimal beacon-proxy for gas-optimized escrow deployment
 * @dev Uses EIP-1967 beacon proxy pattern with minimal bytecode
 *
 * This proxy:
 * 1. Reads implementation address from beacon contract
 * 2. Delegates all calls to implementation via DELEGATECALL
 * 3. Returns/reverts with implementation's return data
 *
 * GAS OPTIMIZATION:
 * - Minimal bytecode (~200 bytes vs 900k for full contract)
 * - Single SLOAD for beacon address
 * - Single external call to beacon for implementation
 * - Single DELEGATECALL to implementation
 *
 * STORAGE LAYOUT (EIP-1967):
 * Slot 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50:
 *   beacon address (20 bytes)
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrowProxy {
    /**
     * @notice EIP-1967 beacon storage slot
     * @dev keccak256("eip1967.proxy.beacon") - 1
     */
    bytes32 private constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    /**
     * @notice Emitted when the beacon is upgraded
     */
    event BeaconUpgraded(address indexed beacon);

    /**
     * @notice Constructor sets the beacon address
     * @dev Beacon address is immutable after construction
     * @param beacon Address of the beacon contract
     */
    constructor(address beacon) {
        require(beacon != address(0), "Beacon is zero address");

        // Store beacon address in EIP-1967 slot
        bytes32 slot = BEACON_SLOT;
        assembly {
            sstore(slot, beacon)
        }

        emit BeaconUpgraded(beacon);
    }

    /**
     * @notice Get the beacon address
     * @return beacon Address of the beacon contract
     */
    function _getBeacon() internal view returns (address beacon) {
        bytes32 slot = BEACON_SLOT;
        assembly {
            beacon := sload(slot)
        }
    }

    /**
     * @notice Get implementation address from beacon
     * @return implementation Address of the implementation contract
     */
    function _getImplementation() internal view returns (address) {
        address beacon = _getBeacon();

        // Call beacon.implementation() to get the implementation address
        (bool success, bytes memory returndata) = beacon.staticcall(
            abi.encodeWithSignature("implementation()")
        );

        require(success, "Beacon call failed");
        return abi.decode(returndata, (address));
    }

    /**
     * @notice Fallback function that delegates calls to the implementation
     * @dev Uses DELEGATECALL to preserve msg.sender and msg.value
     */
    fallback() external payable {
        address impl = _getImplementation();

        assembly {
            // Copy msg.data to memory
            calldatacopy(0, 0, calldatasize())

            // Delegate call to implementation
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)

            // Copy return data to memory
            returndatacopy(0, 0, returndatasize())

            // Return or revert based on result
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    /**
     * @notice Receive function to accept ETH
     */
    receive() external payable {}
}
