// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/optimized/UnicitySwapEscrowImplementationArray.sol";
import "../src/UnicitySwapEscrowBeacon.sol";
import "../src/optimized/UnicitySwapEscrowFactoryOptimized.sol";
import "../src/mocks/MockERC20.sol";

/**
 * @title DeployArrayStorageTestnet
 * @notice Testnet deployment script with additional testing and verification
 * @dev Deploys: Implementation → Beacon → Factory → Test Escrow + Mock ERC20
 *
 * FEATURES:
 * - Deploys full system
 * - Creates test ERC20 token
 * - Creates sample escrow instance
 * - Runs verification tests
 * - Generates detailed logs
 *
 * USAGE:
 *   forge script script/DeployArrayStorageTestnet.s.sol:DeployArrayStorageTestnet \
 *     --rpc-url $TESTNET_RPC_URL \
 *     --broadcast \
 *     --verify
 */
contract DeployArrayStorageTestnet is Script {

    function run() external {
        // Read deployer private key from environment
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("==========================================");
        console.log("TESTNET DEPLOYMENT - ARRAY STORAGE ESCROW");
        console.log("==========================================");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("Block number:", block.number);
        console.log("==========================================");

        // PRE-DEPLOYMENT CHECKS
        console.log("\n[1/7] Pre-deployment checks...");

        uint256 deployerBalance = deployer.balance;
        console.log("Deployer balance:", deployerBalance / 1e18, "native currency");
        require(deployerBalance > 0.01 ether, "Insufficient deployer balance");

        vm.startBroadcast(deployerPrivateKey);

        // STEP 1: Deploy Implementation
        console.log("\n[2/7] Deploying Implementation...");
        UnicitySwapEscrowImplementationArray implementation =
            new UnicitySwapEscrowImplementationArray();
        console.log("Implementation deployed at:", address(implementation));

        // Log hardcoded addresses (OK for testnet to use test addresses)
        console.log("Hardcoded addresses (testnet):");
        console.log("  ESCROW_OPERATOR:", implementation.escrowOperator());
        console.log("  FEE_RECIPIENT:", implementation.feeRecipient());
        console.log("  GAS_TANK:", implementation.gasTank());

        // STEP 2: Deploy Beacon
        console.log("\n[3/7] Deploying Beacon...");
        UnicitySwapEscrowBeacon beacon =
            new UnicitySwapEscrowBeacon(address(implementation), deployer);
        console.log("Beacon deployed at:", address(beacon));
        console.log("Beacon owner:", beacon.owner());

        // STEP 3: Deploy Factory
        console.log("\n[4/7] Deploying Factory...");
        UnicitySwapEscrowFactoryOptimized factory =
            new UnicitySwapEscrowFactoryOptimized(address(beacon));
        console.log("Factory deployed at:", address(factory));

        // STEP 4: Deploy Mock ERC20 for testing
        console.log("\n[5/7] Deploying Mock ERC20 token...");
        MockERC20 testToken = new MockERC20("Test USDC", "TUSDC", 6);
        console.log("Mock ERC20 deployed at:", address(testToken));

        // Mint test tokens to deployer
        testToken.mint(deployer, 1000000 * 10**6); // 1M TUSDC
        console.log("Minted 1,000,000 TUSDC to deployer");

        // STEP 5: Create test escrow instance
        console.log("\n[6/7] Creating test escrow...");

        address payable testPayback = payable(address(0x1001));
        address payable testRecipient = payable(address(0x1002));
        uint256 testSwapValue = 1000 * 10**6; // 1000 TUSDC
        uint256 testFeeValue = 3 * 10**6;     // 3 TUSDC (0.3%)

        address testEscrow = factory.createEscrow(
            testPayback,
            testRecipient,
            address(testToken),
            testSwapValue,
            testFeeValue
        );

        console.log("Test escrow created at:", testEscrow);

        // STEP 6: Verify deployment
        console.log("\n[7/7] Running verification tests...");

        // Test 1: Verify beacon points to implementation
        require(beacon.implementation() == address(implementation),
            "FAIL: Beacon implementation mismatch");
        console.log("[OK] Beacon points to correct implementation");

        // Test 2: Verify factory points to beacon
        require(factory.beacon() == address(beacon),
            "FAIL: Factory beacon mismatch");
        console.log("[OK] Factory points to correct beacon");

        // Test 3: Verify escrow initialization
        UnicitySwapEscrowImplementationArray escrow =
            UnicitySwapEscrowImplementationArray(payable(testEscrow));

        require(escrow.payback() == testPayback,
            "FAIL: Escrow payback mismatch");
        require(escrow.recipient() == testRecipient,
            "FAIL: Escrow recipient mismatch");
        require(escrow.currency() == address(testToken),
            "FAIL: Escrow currency mismatch");
        require(escrow.swapValue() == testSwapValue,
            "FAIL: Escrow swapValue mismatch");
        require(escrow.feeValue() == testFeeValue,
            "FAIL: Escrow feeValue mismatch");
        console.log("[OK] Test escrow initialized correctly");

        // Test 4: Verify state machine
        require(uint8(escrow.state()) == uint8(UnicitySwapEscrowImplementationArray.State.COLLECTION),
            "FAIL: Escrow initial state incorrect");
        console.log("[OK] Escrow in COLLECTION state");

        // Test 5: Verify canSwap logic
        require(!escrow.canSwap(), "FAIL: canSwap should be false with no funds");
        console.log("[OK] canSwap returns false (no funds)");

        // Fund escrow with tokens
        testToken.transfer(testEscrow, testSwapValue + testFeeValue);
        require(escrow.canSwap(), "FAIL: canSwap should be true with sufficient funds");
        console.log("[OK] canSwap returns true (sufficient funds)");

        // Test 6: Verify storage layout (array storage)
        require(escrow.getBalance() == testSwapValue + testFeeValue,
            "FAIL: Balance mismatch");
        console.log("[OK] Storage layout working correctly");

        vm.stopBroadcast();

        // POST-DEPLOYMENT SUMMARY
        console.log("\n==========================================");
        console.log("TESTNET DEPLOYMENT SUMMARY");
        console.log("==========================================");
        console.log("Network: Testnet (Chain ID:", block.chainid, ")");
        console.log("");
        console.log("Core Contracts:");
        console.log("  Implementation:", address(implementation));
        console.log("  Beacon:", address(beacon));
        console.log("  Factory:", address(factory));
        console.log("");
        console.log("Test Contracts:");
        console.log("  Mock ERC20:", address(testToken));
        console.log("  Test Escrow:", testEscrow);
        console.log("");
        console.log("Configuration:");
        console.log("  Operator:", implementation.escrowOperator());
        console.log("  Fee Recipient:", implementation.feeRecipient());
        console.log("  Gas Tank:", implementation.gasTank());
        console.log("  Fee BPS: 30 (0.3%)");
        console.log("==========================================");

        console.log("\n[OK] ALL TESTS PASSED!");
        console.log("\nNEXT STEPS:");
        console.log("1. Verify contracts on testnet explorer");
        console.log("2. Test full swap flow:");
        console.log("   a. Fund escrow:", testEscrow);
        console.log("   b. Call swap() as operator");
        console.log("   c. Verify transfers to recipient and feeRecipient");
        console.log("3. Test revert flow");
        console.log("4. Test edge cases (zero values, max uint256)");
        console.log("5. Run gas profiling");
        console.log("==========================================");

        // Save deployment info
        console.log("\nDeployment info would be saved to deployments/testnet-{chainId}.json");
        console.log("Please manually record the addresses above.");
    }
}
