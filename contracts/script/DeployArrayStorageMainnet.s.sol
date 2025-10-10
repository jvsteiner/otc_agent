// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/optimized/UnicitySwapEscrowImplementationArray.sol";
import "../src/UnicitySwapEscrowBeacon.sol";
import "../src/optimized/UnicitySwapEscrowFactoryOptimized.sol";

/**
 * @title DeployArrayStorageMainnet
 * @notice Production deployment script for array storage escrow system
 * @dev Deploys: Implementation → Beacon → Factory
 *
 * PREREQUISITES:
 * 1. Set DEPLOYER_PRIVATE_KEY in .env
 * 2. Update hardcoded addresses in UnicitySwapEscrowImplementationArray.sol:
 *    - ESCROW_OPERATOR
 *    - FEE_RECIPIENT
 *    - GAS_TANK
 * 3. Fund deployer address with sufficient gas
 *
 * USAGE:
 *   forge script script/DeployArrayStorageMainnet.s.sol:DeployArrayStorageMainnet \
 *     --rpc-url $RPC_URL \
 *     --broadcast \
 *     --verify
 */
contract DeployArrayStorageMainnet is Script {

    function run() external {
        // Read deployer private key from environment
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("==========================================");
        console.log("MAINNET DEPLOYMENT - ARRAY STORAGE ESCROW");
        console.log("==========================================");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("==========================================");

        // PRE-DEPLOYMENT CHECKS
        console.log("\n[1/4] Pre-deployment checks...");

        // Check deployer balance
        uint256 deployerBalance = deployer.balance;
        console.log("Deployer balance:", deployerBalance / 1e18, "ETH");
        require(deployerBalance > 0.05 ether, "Insufficient deployer balance (need >0.05 ETH)");

        vm.startBroadcast(deployerPrivateKey);

        // STEP 1: Deploy Implementation
        console.log("\n[2/4] Deploying Implementation...");
        UnicitySwapEscrowImplementationArray implementation =
            new UnicitySwapEscrowImplementationArray();
        console.log("Implementation deployed at:", address(implementation));

        // Verify hardcoded addresses
        address operator = implementation.escrowOperator();
        address payable feeRecipient = implementation.feeRecipient();
        address payable gasTank = implementation.gasTank();

        console.log("\n>>> CRITICAL: Verify hardcoded addresses <<<");
        console.log("ESCROW_OPERATOR:", operator);
        console.log("FEE_RECIPIENT:", feeRecipient);
        console.log("GAS_TANK:", gasTank);

        // Security check: ensure addresses are not test addresses
        require(operator != address(0x0000000000000000000000000000000000000001),
            "SECURITY: ESCROW_OPERATOR is test address!");
        require(feeRecipient != address(0x0000000000000000000000000000000000000002),
            "SECURITY: FEE_RECIPIENT is test address!");
        require(gasTank != address(0x0000000000000000000000000000000000000003),
            "SECURITY: GAS_TANK is test address!");

        // STEP 2: Deploy Beacon
        console.log("\n[3/4] Deploying Beacon...");
        UnicitySwapEscrowBeacon beacon =
            new UnicitySwapEscrowBeacon(address(implementation), deployer);
        console.log("Beacon deployed at:", address(beacon));
        console.log("Beacon owner:", beacon.owner());
        console.log("Beacon points to:", beacon.implementation());

        require(beacon.implementation() == address(implementation),
            "Beacon misconfigured: implementation mismatch");

        // STEP 3: Deploy Factory
        console.log("\n[4/4] Deploying Factory...");
        UnicitySwapEscrowFactoryOptimized factory =
            new UnicitySwapEscrowFactoryOptimized(address(beacon));
        console.log("Factory deployed at:", address(factory));
        console.log("Factory beacon:", factory.beacon());

        require(factory.beacon() == address(beacon),
            "Factory misconfigured: beacon mismatch");

        vm.stopBroadcast();

        // POST-DEPLOYMENT VERIFICATION
        console.log("\n==========================================");
        console.log("DEPLOYMENT SUMMARY");
        console.log("==========================================");
        console.log("Implementation:", address(implementation));
        console.log("Beacon:", address(beacon));
        console.log("Factory:", address(factory));
        console.log("==========================================");
        console.log("Configuration:");
        console.log("  Operator:", operator);
        console.log("  Fee Recipient:", feeRecipient);
        console.log("  Gas Tank:", gasTank);
        console.log("  Fee BPS: 30 (0.3%)");
        console.log("==========================================");

        // Gas cost summary
        console.log("\nEstimated gas costs:");
        console.log("  Implementation: ~870k gas");
        console.log("  Beacon: ~177k gas");
        console.log("  Factory: ~616k gas");
        console.log("  TOTAL: ~1.66M gas");

        console.log("\n[OK] DEPLOYMENT SUCCESSFUL!");
        console.log("\nNEXT STEPS:");
        console.log("1. Verify contracts on block explorer");
        console.log("2. Update backend configuration with factory address");
        console.log("3. Test with small escrow creation");
        console.log("4. Monitor first production swaps closely");
        console.log("==========================================");

        // Save deployment addresses to file
        console.log("\nDeployment info would be saved to deployments/mainnet-{chainId}.json");
        console.log("Please manually record the addresses above.");
    }
}
