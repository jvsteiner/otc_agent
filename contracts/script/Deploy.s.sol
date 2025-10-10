// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/UnicitySwapEscrow.sol";
import "../src/UnicitySwapEscrowFactory.sol";
import "../src/UnicitySwapEscrowBeacon.sol";

/**
 * @title DeployScript
 * @notice Deployment script for UnicitySwapEscrow system
 * @dev Run with: forge script script/Deploy.s.sol:DeployScript --rpc-url <RPC_URL> --broadcast
 */
contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying from:", deployer);
        console.log("Deployer balance:", deployer.balance);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy factory
        UnicitySwapEscrowFactory factory = new UnicitySwapEscrowFactory();
        console.log("UnicitySwapEscrowFactory deployed at:", address(factory));

        vm.stopBroadcast();

        console.log("\n=== Deployment Complete ===");
        console.log("Factory:", address(factory));
        console.log("\nTo create an escrow, call:");
        console.log("factory.createEscrow(...)");
    }
}

/**
 * @title DeployWithBeaconScript
 * @notice Alternative deployment using beacon proxy pattern (for upgradeable escrows)
 * @dev Run with: forge script script/Deploy.s.sol:DeployWithBeaconScript --rpc-url <RPC_URL> --broadcast
 */
contract DeployWithBeaconScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying beacon system from:", deployer);
        console.log("Deployer balance:", deployer.balance);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy implementation
        UnicitySwapEscrow implementation = new UnicitySwapEscrow(
            address(0x1), // Dummy operator
            keccak256("IMPLEMENTATION"),
            payable(address(0x1)),
            payable(address(0x1)),
            payable(address(0x1)),
            payable(address(0x1)),
            address(0x1),
            1,
            1
        );
        console.log("Implementation deployed at:", address(implementation));

        // Deploy beacon
        UnicitySwapEscrowBeacon beacon = new UnicitySwapEscrowBeacon(
            address(implementation),
            deployer // Owner can upgrade
        );
        console.log("Beacon deployed at:", address(beacon));

        vm.stopBroadcast();

        console.log("\n=== Deployment Complete ===");
        console.log("Implementation:", address(implementation));
        console.log("Beacon:", address(beacon));
        console.log("Beacon Owner:", deployer);
        console.log("\nNote: Deploy proxies via BeaconProxy or use regular factory");
    }
}

/**
 * @title DeployTestEscrowScript
 * @notice Deploy a single test escrow for verification
 */
contract DeployTestEscrowScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying test escrow from:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy test escrow
        UnicitySwapEscrow escrow = new UnicitySwapEscrow(
            deployer, // Operator
            keccak256("TEST_DEAL_001"),
            payable(deployer), // Payback
            payable(deployer), // Recipient
            payable(deployer), // Fee recipient
            payable(deployer), // Gas tank
            address(0), // Native ETH
            1 ether, // Swap value
            0.01 ether // Fee value
        );

        console.log("Test escrow deployed at:", address(escrow));
        console.log("Operator:", escrow.escrowOperator());
        console.log("Swap value:", escrow.swapValue());
        console.log("Fee value:", escrow.feeValue());

        vm.stopBroadcast();
    }
}
