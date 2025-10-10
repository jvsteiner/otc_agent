// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/optimized/UnicitySwapEscrowImplementation.sol";
import "../src/optimized/UnicitySwapEscrowFactoryOptimized.sol";
import "../src/UnicitySwapEscrowBeacon.sol";

/**
 * @title DeployOptimized
 * @notice Deployment script for optimized beacon-proxy escrow system
 *
 * DEPLOYMENT ORDER (one-time setup):
 * 1. Deploy UnicitySwapEscrowImplementation (~2M gas)
 * 2. Deploy UnicitySwapEscrowBeacon pointing to implementation (~300k gas)
 * 3. Deploy UnicitySwapEscrowFactoryOptimized with beacon address (~500k gas)
 *
 * ONGOING USAGE:
 * - Call factory.createEscrow() for each new deal (~130k gas per escrow)
 *
 * GAS SAVINGS:
 * - Old: 915k gas per escrow
 * - New: ~130k gas per escrow (after one-time setup)
 * - Savings: 85% reduction (770k gas per escrow)
 *
 * USAGE:
 * forge script script/DeployOptimized.s.sol:DeployOptimized --rpc-url <RPC_URL> --broadcast --verify
 */
contract DeployOptimized is Script {
    function run() external {
        // Load deployer private key
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("===============================================");
        console.log("DEPLOYING OPTIMIZED BEACON-PROXY ESCROW SYSTEM");
        console.log("===============================================");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy implementation
        console.log("1. Deploying UnicitySwapEscrowImplementation...");
        uint256 gasBeforeImpl = gasleft();
        UnicitySwapEscrowImplementation implementation = new UnicitySwapEscrowImplementation();
        uint256 gasUsedImpl = gasBeforeImpl - gasleft();
        console.log("   Implementation deployed at:", address(implementation));
        console.log("   Gas used:", gasUsedImpl);
        console.log("");

        // 2. Deploy beacon
        console.log("2. Deploying UnicitySwapEscrowBeacon...");
        uint256 gasBeforeBeacon = gasleft();
        UnicitySwapEscrowBeacon beacon = new UnicitySwapEscrowBeacon(
            address(implementation),
            deployer // Beacon owner (can upgrade implementation)
        );
        uint256 gasUsedBeacon = gasBeforeBeacon - gasleft();
        console.log("   Beacon deployed at:", address(beacon));
        console.log("   Beacon owner:", deployer);
        console.log("   Gas used:", gasUsedBeacon);
        console.log("");

        // 3. Deploy factory
        console.log("3. Deploying UnicitySwapEscrowFactoryOptimized...");
        uint256 gasBeforeFactory = gasleft();
        UnicitySwapEscrowFactoryOptimized factory = new UnicitySwapEscrowFactoryOptimized(
            address(beacon)
        );
        uint256 gasUsedFactory = gasBeforeFactory - gasleft();
        console.log("   Factory deployed at:", address(factory));
        console.log("   Gas used:", gasUsedFactory);
        console.log("");

        vm.stopBroadcast();

        // Summary
        console.log("===============================================");
        console.log("DEPLOYMENT SUMMARY");
        console.log("===============================================");
        console.log("Implementation:", address(implementation));
        console.log("Beacon:", address(beacon));
        console.log("Factory:", address(factory));
        console.log("");
        console.log("Total one-time setup gas:", gasUsedImpl + gasUsedBeacon + gasUsedFactory);
        console.log("");
        console.log("IMPORTANT: Update hardcoded constants in UnicitySwapEscrowImplementation.sol:");
        console.log("  - ESCROW_OPERATOR: Set to your backend operator address");
        console.log("  - FEE_RECIPIENT: Set to your fee collection address");
        console.log("  - GAS_TANK: Set to your gas tank address");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Verify contracts on block explorer");
        console.log("2. Update backend configuration with factory address");
        console.log("3. Call factory.createEscrow() to create new escrows (~130k gas each)");
        console.log("===============================================");
    }

    /**
     * @notice Alternative deployment for testing/local networks
     * @dev Includes test escrow creation and gas measurement
     */
    function runWithTest() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("===============================================");
        console.log("DEPLOYING + TESTING OPTIMIZED ESCROW SYSTEM");
        console.log("===============================================");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy system
        UnicitySwapEscrowImplementation implementation = new UnicitySwapEscrowImplementation();
        UnicitySwapEscrowBeacon beacon = new UnicitySwapEscrowBeacon(
            address(implementation),
            deployer
        );
        UnicitySwapEscrowFactoryOptimized factory = new UnicitySwapEscrowFactoryOptimized(
            address(beacon)
        );

        console.log("System deployed successfully!");
        console.log("Factory:", address(factory));
        console.log("");

        // Test: Create sample escrow and measure gas
        console.log("Creating test escrow...");
        uint256 gasBeforeEscrow = gasleft();

        address testEscrow = factory.createEscrow(
            payable(deployer),       // payback
            payable(deployer),       // recipient
            address(0),              // native currency
            1 ether,                 // swap value
            0.003 ether              // fee value (0.3% of 1 ether)
        );

        uint256 gasUsedEscrow = gasBeforeEscrow - gasleft();

        console.log("Test escrow created at:", testEscrow);
        console.log("Gas used for escrow deployment:", gasUsedEscrow);
        console.log("");

        // Verify escrow is initialized correctly
        UnicitySwapEscrowImplementation escrow = UnicitySwapEscrowImplementation(payable(testEscrow));
        console.log("Escrow verification:");
        console.log("  - Payback:", escrow.payback());
        console.log("  - Recipient:", escrow.recipient());
        console.log("  - Swap value:", escrow.swapValue());
        console.log("  - Fee value:", escrow.feeValue());
        console.log("  - State:", uint8(escrow.state()));
        console.log("");

        // Create multiple escrows to show consistent gas usage
        console.log("Creating 5 more escrows for gas measurement...");
        uint256 totalGas = 0;
        for (uint256 i = 0; i < 5; i++) {
            uint256 gasBefore = gasleft();
            uint256 swapVal = (i + 2) * 1 ether;
            factory.createEscrow(
                payable(deployer),
                payable(deployer),
                address(0),
                swapVal,
                (swapVal * 30) / 10000  // 0.3% fee
            );
            uint256 gasUsed = gasBefore - gasleft();
            totalGas += gasUsed;
            console.log("  Escrow", i + 1, "gas:", gasUsed);
        }
        uint256 avgGas = totalGas / 5;
        console.log("Average gas per escrow:", avgGas);

        vm.stopBroadcast();

        console.log("");
        console.log("===============================================");
        console.log("TEST SUMMARY");
        console.log("===============================================");
        console.log("First escrow gas:", gasUsedEscrow);
        console.log("Average gas (next 5):", avgGas);
        console.log("Target: < 150k gas");
        console.log("Status:", avgGas < 150000 ? "PASS" : "FAIL");
        console.log("===============================================");
    }
}
