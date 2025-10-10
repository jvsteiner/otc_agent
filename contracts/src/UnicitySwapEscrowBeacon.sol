// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/**
 * @title UnicitySwapEscrowBeacon
 * @notice Beacon contract holding the implementation address for UnicitySwapEscrow proxies
 * @dev Extends OpenZeppelin's UpgradeableBeacon which already includes Ownable
 *
 * The beacon pattern allows:
 * - Single implementation contract deployed once
 * - Multiple lightweight proxy instances
 * - Upgradeable implementation (if needed)
 * - Gas-efficient deployment of new escrows
 *
 * @custom:security-contact security@unicity.io
 */
contract UnicitySwapEscrowBeacon is UpgradeableBeacon {
    /**
     * @notice Initialize beacon with implementation address
     * @param implementation_ Address of UnicitySwapEscrow implementation
     * @param initialOwner Address of beacon owner (can upgrade implementation)
     */
    constructor(address implementation_, address initialOwner)
        UpgradeableBeacon(implementation_, initialOwner)
    {}
}
