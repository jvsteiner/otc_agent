// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../src/optimized/UnicitySwapEscrowImplementation.sol";
import "../../src/optimized/UnicitySwapEscrowImplementationPacked.sol";
import "../../src/UnicitySwapEscrowBeacon.sol";
import "../../src/optimized/UnicitySwapEscrowFactoryOptimized.sol";
import "../../src/mocks/MockERC20.sol";

/**
 * @title PackedStorageGasTest
 * @notice Comprehensive gas comparison: 5-slot vs 3-slot packed storage
 * @dev Measures gas costs for all operations and provides break-even analysis
 */
contract PackedStorageGasTest is Test {
    // Actors
    address constant OPERATOR = address(0x1);
    address constant FEE_RECIPIENT = address(0x2);
    address constant GAS_TANK = address(0x3);
    address payable constant ALICE = payable(address(0x100)); // Payback
    address payable constant BOB = payable(address(0x200));   // Recipient

    // Implementations
    UnicitySwapEscrowImplementation public impl5Slot;
    UnicitySwapEscrowImplementationPacked public implPacked;

    // Beacons
    UnicitySwapEscrowBeacon public beacon5Slot;
    UnicitySwapEscrowBeacon public beaconPacked;

    // Factories
    UnicitySwapEscrowFactoryOptimized public factory5Slot;
    UnicitySwapEscrowFactoryOptimized public factoryPacked;

    // Test tokens
    MockERC20 public token;

    // Test values
    uint256 constant SWAP_VALUE = 1000 ether;
    uint256 constant FEE_VALUE = 3 ether; // 0.3% of 1000
    uint256 constant DEPOSIT_AMOUNT = 1010 ether; // Swap + fee + surplus

    function setUp() public {
        // Deploy mock token
        token = new MockERC20("Test Token", "TEST", 18);

        // ========================================
        // Deploy 5-slot implementation
        // ========================================
        impl5Slot = new UnicitySwapEscrowImplementation();
        beacon5Slot = new UnicitySwapEscrowBeacon(address(impl5Slot), address(this));
        factory5Slot = new UnicitySwapEscrowFactoryOptimized(address(beacon5Slot));

        // ========================================
        // Deploy packed implementation
        // ========================================
        implPacked = new UnicitySwapEscrowImplementationPacked();
        beaconPacked = new UnicitySwapEscrowBeacon(address(implPacked), address(this));
        factoryPacked = new UnicitySwapEscrowFactoryOptimized(address(beaconPacked));

        // Fund accounts
        deal(ALICE, 100 ether);
        deal(BOB, 100 ether);
        token.mint(ALICE, 10000 ether);
        token.mint(BOB, 10000 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON: DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_Deployment_NativeToken() public {
        console.log("\n=== DEPLOYMENT GAS COMPARISON (Native Token) ===");

        // Deploy 5-slot escrow
        uint256 gasBefore = gasleft();
        address escrow5 = factory5Slot.createEscrow(
            ALICE,
            BOB,
            address(0), // Native token
            SWAP_VALUE,
            FEE_VALUE
        );
        uint256 gas5Slot = gasBefore - gasleft();

        // Deploy packed escrow
        gasBefore = gasleft();
        address escrowPacked = factoryPacked.createEscrow(
            ALICE,
            BOB,
            address(0), // Native token
            SWAP_VALUE,
            FEE_VALUE
        );
        uint256 gasPacked = gasBefore - gasleft();

        // Report results
        console.log("5-slot deployment:       ", gas5Slot);
        console.log("Packed deployment:       ", gasPacked);
        console.log("Savings (gas):           ", gas5Slot - gasPacked);
        console.log("Savings (%):             ", ((gas5Slot - gasPacked) * 100) / gas5Slot);

        // Verify both escrows initialized correctly
        assertEq(UnicitySwapEscrowImplementation(payable(escrow5)).payback(), ALICE);
        assertEq(UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).payback(), ALICE);
    }

    function test_GasComparison_Deployment_ERC20Token() public {
        console.log("\n=== DEPLOYMENT GAS COMPARISON (ERC20 Token) ===");

        // Deploy 5-slot escrow
        uint256 gasBefore = gasleft();
        address escrow5 = factory5Slot.createEscrow(
            ALICE,
            BOB,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        uint256 gas5Slot = gasBefore - gasleft();

        // Deploy packed escrow
        gasBefore = gasleft();
        address escrowPacked = factoryPacked.createEscrow(
            ALICE,
            BOB,
            address(token),
            SWAP_VALUE,
            FEE_VALUE
        );
        uint256 gasPacked = gasBefore - gasleft();

        // Report results
        console.log("5-slot deployment:       ", gas5Slot);
        console.log("Packed deployment:       ", gasPacked);
        console.log("Savings (gas):           ", gas5Slot - gasPacked);
        console.log("Savings (%):             ", ((gas5Slot - gasPacked) * 100) / gas5Slot);

        // Verify both escrows initialized correctly
        assertEq(UnicitySwapEscrowImplementation(payable(escrow5)).currency(), address(token));
        assertEq(UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).currency(), address(token));
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON: SWAP OPERATION
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_Swap_NativeToken() public {
        console.log("\n=== SWAP OPERATION GAS COMPARISON (Native Token) ===");

        // Create escrows
        address escrow5 = factory5Slot.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);
        address escrowPacked = factoryPacked.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);

        // Fund both escrows
        deal(escrow5, DEPOSIT_AMOUNT);
        deal(escrowPacked, DEPOSIT_AMOUNT);

        // Execute swap on 5-slot escrow
        vm.prank(OPERATOR);
        uint256 gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).swap();
        uint256 gas5Slot = gasBefore - gasleft();

        // Execute swap on packed escrow
        vm.prank(OPERATOR);
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).swap();
        uint256 gasPacked = gasBefore - gasleft();

        // Report results
        console.log("5-slot swap:             ", gas5Slot);
        console.log("Packed swap:             ", gasPacked);
        if (gasPacked > gas5Slot) {
            console.log("Overhead (gas):          ", gasPacked - gas5Slot);
            console.log("Overhead (%):            ", ((gasPacked - gas5Slot) * 100) / gas5Slot);
        } else {
            console.log("Savings (gas):           ", gas5Slot - gasPacked);
            console.log("Savings (%):             ", ((gas5Slot - gasPacked) * 100) / gas5Slot);
        }

        // Verify both swaps succeeded
        assertEq(uint(UnicitySwapEscrowImplementation(payable(escrow5)).state()), uint(UnicitySwapEscrowImplementation.State.COMPLETED));
        assertEq(uint(UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).state()), uint(UnicitySwapEscrowImplementationPacked.State.COMPLETED));
    }

    function test_GasComparison_Swap_ERC20Token() public {
        console.log("\n=== SWAP OPERATION GAS COMPARISON (ERC20 Token) ===");

        // Create escrows
        address escrow5 = factory5Slot.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);
        address escrowPacked = factoryPacked.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);

        // Fund both escrows
        token.mint(escrow5, DEPOSIT_AMOUNT);
        token.mint(escrowPacked, DEPOSIT_AMOUNT);

        // Execute swap on 5-slot escrow
        vm.prank(OPERATOR);
        uint256 gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).swap();
        uint256 gas5Slot = gasBefore - gasleft();

        // Execute swap on packed escrow
        vm.prank(OPERATOR);
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).swap();
        uint256 gasPacked = gasBefore - gasleft();

        // Report results
        console.log("5-slot swap:             ", gas5Slot);
        console.log("Packed swap:             ", gasPacked);
        if (gasPacked > gas5Slot) {
            console.log("Overhead (gas):          ", gasPacked - gas5Slot);
            console.log("Overhead (%):            ", ((gasPacked - gas5Slot) * 100) / gas5Slot);
        } else {
            console.log("Savings (gas):           ", gas5Slot - gasPacked);
            console.log("Savings (%):             ", ((gas5Slot - gasPacked) * 100) / gas5Slot);
        }

        // Verify balances
        assertEq(token.balanceOf(BOB), SWAP_VALUE);
        assertEq(token.balanceOf(FEE_RECIPIENT), FEE_VALUE);
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON: REVERT OPERATION
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_Revert_NativeToken() public {
        console.log("\n=== REVERT OPERATION GAS COMPARISON (Native Token) ===");

        // Create escrows
        address escrow5 = factory5Slot.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);
        address escrowPacked = factoryPacked.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);

        // Fund both escrows (partial funding)
        deal(escrow5, 500 ether);
        deal(escrowPacked, 500 ether);

        // Execute revert on 5-slot escrow
        vm.prank(OPERATOR);
        uint256 gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).revertEscrow();
        uint256 gas5Slot = gasBefore - gasleft();

        // Execute revert on packed escrow
        vm.prank(OPERATOR);
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).revertEscrow();
        uint256 gasPacked = gasBefore - gasleft();

        // Report results
        console.log("5-slot revert:           ", gas5Slot);
        console.log("Packed revert:           ", gasPacked);
        if (gasPacked > gas5Slot) {
            console.log("Overhead (gas):          ", gasPacked - gas5Slot);
            console.log("Overhead (%):            ", ((gasPacked - gas5Slot) * 100) / gas5Slot);
        } else {
            console.log("Savings (gas):           ", gas5Slot - gasPacked);
            console.log("Savings (%):             ", ((gas5Slot - gasPacked) * 100) / gas5Slot);
        }
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON: REFUND OPERATION
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_Refund_NativeToken() public {
        console.log("\n=== REFUND OPERATION GAS COMPARISON (Native Token) ===");

        // Create and complete swaps
        address escrow5 = factory5Slot.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);
        address escrowPacked = factoryPacked.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);

        deal(escrow5, DEPOSIT_AMOUNT);
        deal(escrowPacked, DEPOSIT_AMOUNT);

        vm.prank(OPERATOR);
        UnicitySwapEscrowImplementation(payable(escrow5)).swap();

        vm.prank(OPERATOR);
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).swap();

        // Add more funds after swap (to test refund)
        deal(escrow5, escrow5.balance + 1 ether);
        deal(escrowPacked, escrowPacked.balance + 1 ether);

        // Execute refund on 5-slot escrow
        uint256 gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).refund();
        uint256 gas5Slot = gasBefore - gasleft();

        // Execute refund on packed escrow
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).refund();
        uint256 gasPacked = gasBefore - gasleft();

        // Report results
        console.log("5-slot refund:           ", gas5Slot);
        console.log("Packed refund:           ", gasPacked);
        if (gasPacked > gas5Slot) {
            console.log("Overhead (gas):          ", gasPacked - gas5Slot);
            console.log("Overhead (%):            ", ((gasPacked - gas5Slot) * 100) / gas5Slot);
        } else {
            console.log("Savings (gas):           ", gas5Slot - gasPacked);
            console.log("Savings (%):             ", ((gas5Slot - gasPacked) * 100) / gas5Slot);
        }
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON: SWEEP OPERATION
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_Sweep_ERC20Token() public {
        console.log("\n=== SWEEP OPERATION GAS COMPARISON (ERC20 Token) ===");

        // Create and complete swaps with native token
        address escrow5 = factory5Slot.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);
        address escrowPacked = factoryPacked.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);

        deal(escrow5, DEPOSIT_AMOUNT);
        deal(escrowPacked, DEPOSIT_AMOUNT);

        vm.prank(OPERATOR);
        UnicitySwapEscrowImplementation(payable(escrow5)).swap();

        vm.prank(OPERATOR);
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).swap();

        // Send ERC20 tokens to escrows (different currency)
        token.mint(escrow5, 100 ether);
        token.mint(escrowPacked, 100 ether);

        // Execute sweep on 5-slot escrow
        uint256 gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).sweep(address(token));
        uint256 gas5Slot = gasBefore - gasleft();

        // Execute sweep on packed escrow
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).sweep(address(token));
        uint256 gasPacked = gasBefore - gasleft();

        // Report results
        console.log("5-slot sweep:            ", gas5Slot);
        console.log("Packed sweep:            ", gasPacked);
        if (gasPacked > gas5Slot) {
            console.log("Overhead (gas):          ", gasPacked - gas5Slot);
            console.log("Overhead (%):            ", ((gasPacked - gas5Slot) * 100) / gas5Slot);
        } else {
            console.log("Savings (gas):           ", gas5Slot - gasPacked);
            console.log("Savings (%):             ", ((gas5Slot - gasPacked) * 100) / gas5Slot);
        }

        // Verify sweeps succeeded
        assertEq(token.balanceOf(GAS_TANK), 200 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        GAS COMPARISON: FULL LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function test_GasComparison_FullLifecycle_SuccessfulSwap() public {
        console.log("\n=== FULL LIFECYCLE GAS COMPARISON (Successful Swap) ===");

        uint256 total5Slot = 0;
        uint256 totalPacked = 0;

        // 1. DEPLOYMENT
        uint256 gasBefore = gasleft();
        address escrow5 = factory5Slot.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);
        uint256 deployGas5 = gasBefore - gasleft();
        total5Slot += deployGas5;

        gasBefore = gasleft();
        address escrowPacked = factoryPacked.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);
        uint256 deployGasPacked = gasBefore - gasleft();
        totalPacked += deployGasPacked;

        console.log("\n1. Deployment:");
        console.log("   5-slot:               ", deployGas5);
        console.log("   Packed:               ", deployGasPacked);

        // 2. FUNDING (user deposits - not counted in lifecycle)
        token.mint(escrow5, DEPOSIT_AMOUNT);
        token.mint(escrowPacked, DEPOSIT_AMOUNT);

        // 3. SWAP EXECUTION
        vm.prank(OPERATOR);
        gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).swap();
        uint256 swapGas5 = gasBefore - gasleft();
        total5Slot += swapGas5;

        vm.prank(OPERATOR);
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).swap();
        uint256 swapGasPacked = gasBefore - gasleft();
        totalPacked += swapGasPacked;

        console.log("\n2. Swap execution:");
        console.log("   5-slot:               ", swapGas5);
        console.log("   Packed:               ", swapGasPacked);

        // 4. REFUND (optional surplus)
        token.mint(escrow5, 1 ether);
        token.mint(escrowPacked, 1 ether);

        gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).refund();
        uint256 refundGas5 = gasBefore - gasleft();
        total5Slot += refundGas5;

        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).refund();
        uint256 refundGasPacked = gasBefore - gasleft();
        totalPacked += refundGasPacked;

        console.log("\n3. Refund surplus:");
        console.log("   5-slot:               ", refundGas5);
        console.log("   Packed:               ", refundGasPacked);

        // TOTALS
        console.log("\n=== TOTAL LIFECYCLE GAS ===");
        console.log("5-slot total:            ", total5Slot);
        console.log("Packed total:            ", totalPacked);
        if (totalPacked > total5Slot) {
            console.log("Overhead (gas):          ", totalPacked - total5Slot);
            console.log("Overhead (%):            ", ((totalPacked - total5Slot) * 100) / total5Slot);
        } else {
            console.log("Savings (gas):           ", total5Slot - totalPacked);
            console.log("Savings (%):             ", ((total5Slot - totalPacked) * 100) / total5Slot);
        }
    }

    function test_GasComparison_FullLifecycle_RevertedDeal() public {
        console.log("\n=== FULL LIFECYCLE GAS COMPARISON (Reverted Deal) ===");

        uint256 total5Slot = 0;
        uint256 totalPacked = 0;

        // 1. DEPLOYMENT
        uint256 gasBefore = gasleft();
        address escrow5 = factory5Slot.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);
        uint256 deployGas5 = gasBefore - gasleft();
        total5Slot += deployGas5;

        gasBefore = gasleft();
        address escrowPacked = factoryPacked.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);
        uint256 deployGasPacked = gasBefore - gasleft();
        totalPacked += deployGasPacked;

        console.log("\n1. Deployment:");
        console.log("   5-slot:               ", deployGas5);
        console.log("   Packed:               ", deployGasPacked);

        // 2. PARTIAL FUNDING
        token.mint(escrow5, 500 ether);
        token.mint(escrowPacked, 500 ether);

        // 3. REVERT
        vm.prank(OPERATOR);
        gasBefore = gasleft();
        UnicitySwapEscrowImplementation(payable(escrow5)).revertEscrow();
        uint256 revertGas5 = gasBefore - gasleft();
        total5Slot += revertGas5;

        vm.prank(OPERATOR);
        gasBefore = gasleft();
        UnicitySwapEscrowImplementationPacked(payable(escrowPacked)).revertEscrow();
        uint256 revertGasPacked = gasBefore - gasleft();
        totalPacked += revertGasPacked;

        console.log("\n2. Revert escrow:");
        console.log("   5-slot:               ", revertGas5);
        console.log("   Packed:               ", revertGasPacked);

        // TOTALS
        console.log("\n=== TOTAL LIFECYCLE GAS ===");
        console.log("5-slot total:            ", total5Slot);
        console.log("Packed total:            ", totalPacked);
        if (totalPacked > total5Slot) {
            console.log("Overhead (gas):          ", totalPacked - total5Slot);
            console.log("Overhead (%):            ", ((totalPacked - total5Slot) * 100) / total5Slot);
        } else {
            console.log("Savings (gas):           ", total5Slot - totalPacked);
            console.log("Savings (%):             ", ((total5Slot - totalPacked) * 100) / total5Slot);
        }
    }

    /*//////////////////////////////////////////////////////////////
                        BREAK-EVEN ANALYSIS
    //////////////////////////////////////////////////////////////*/

    function test_BreakEvenAnalysis() public view {
        console.log("\n=== BREAK-EVEN ANALYSIS ===");
        console.log("\nAssumptions:");
        console.log("- Deployment savings:     ~40,000 gas (packed is cheaper)");
        console.log("- Operation overhead:     ~1,000 gas per operation (packed is slower)");
        console.log("\nBreak-even calculation:");
        console.log("Packed version breaks even when:");
        console.log("deployment_savings = num_operations * operation_overhead");
        console.log("40,000 = N * 1,000");
        console.log("N = 40 operations");
        console.log("\nConclusion:");
        console.log("- Use PACKED if: < 40 operations expected per escrow");
        console.log("- Use 5-SLOT if: >= 40 operations expected per escrow");
        console.log("\nTypical OTC escrow: 1-5 operations (deploy, swap, maybe refund/sweep)");
        console.log("RECOMMENDATION: Use PACKED version for OTC use case");
    }

    /*//////////////////////////////////////////////////////////////
                        FUNCTIONAL VERIFICATION
    //////////////////////////////////////////////////////////////*/

    function test_Packed_FunctionalVerification_NativeSwap() public {
        console.log("\n=== FUNCTIONAL VERIFICATION (Native Token) ===");

        // Create packed escrow
        address escrow = factoryPacked.createEscrow(ALICE, BOB, address(0), SWAP_VALUE, FEE_VALUE);
        UnicitySwapEscrowImplementationPacked escrowContract = UnicitySwapEscrowImplementationPacked(payable(escrow));

        // Verify initialization
        assertEq(escrowContract.payback(), ALICE);
        assertEq(escrowContract.recipient(), BOB);
        assertEq(escrowContract.currency(), address(0));
        assertEq(escrowContract.swapValue(), SWAP_VALUE);
        assertEq(escrowContract.feeValue(), FEE_VALUE);
        assertEq(uint(escrowContract.state()), uint(UnicitySwapEscrowImplementationPacked.State.COLLECTION));

        // Fund escrow
        deal(escrow, DEPOSIT_AMOUNT);

        // Execute swap
        vm.prank(OPERATOR);
        escrowContract.swap();

        // Verify state
        assertEq(uint(escrowContract.state()), uint(UnicitySwapEscrowImplementationPacked.State.COMPLETED));
        assertEq(escrowContract.isSwapExecuted(), true);

        // Verify balances
        assertEq(BOB.balance, SWAP_VALUE);
        assertEq(FEE_RECIPIENT.balance, FEE_VALUE);
        assertEq(ALICE.balance, DEPOSIT_AMOUNT - SWAP_VALUE - FEE_VALUE + 100 ether); // +100 from initial deal()

        console.log("All functional tests passed");
    }

    function test_Packed_FunctionalVerification_ERC20Swap() public {
        console.log("\n=== FUNCTIONAL VERIFICATION (ERC20 Token) ===");

        // Create packed escrow
        address escrow = factoryPacked.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);
        UnicitySwapEscrowImplementationPacked escrowContract = UnicitySwapEscrowImplementationPacked(payable(escrow));

        // Fund escrow
        token.mint(escrow, DEPOSIT_AMOUNT);

        // Execute swap
        vm.prank(OPERATOR);
        escrowContract.swap();

        // Verify balances
        assertEq(token.balanceOf(BOB), SWAP_VALUE);
        assertEq(token.balanceOf(FEE_RECIPIENT), FEE_VALUE);
        assertEq(token.balanceOf(ALICE), DEPOSIT_AMOUNT - SWAP_VALUE - FEE_VALUE + 10000 ether); // +10000 from initial mint

        console.log("All functional tests passed");
    }

    function test_Packed_FunctionalVerification_Revert() public {
        console.log("\n=== FUNCTIONAL VERIFICATION (Revert) ===");

        // Create packed escrow
        address escrow = factoryPacked.createEscrow(ALICE, BOB, address(token), SWAP_VALUE, FEE_VALUE);
        UnicitySwapEscrowImplementationPacked escrowContract = UnicitySwapEscrowImplementationPacked(payable(escrow));

        // Partial funding
        token.mint(escrow, 500 ether);

        // Execute revert
        vm.prank(OPERATOR);
        escrowContract.revertEscrow();

        // Verify state
        assertEq(uint(escrowContract.state()), uint(UnicitySwapEscrowImplementationPacked.State.REVERTED));

        // Verify refunds (fee paid, rest to payback)
        assertEq(token.balanceOf(FEE_RECIPIENT), FEE_VALUE);
        assertEq(token.balanceOf(ALICE), 500 ether - FEE_VALUE + 10000 ether); // Original funds - fee + initial mint

        console.log("All functional tests passed");
    }

    function test_Packed_ValueLimits_Uint96Max() public {
        console.log("\n=== VALUE LIMITS TEST (uint96 max) ===");

        uint256 maxUint96 = type(uint96).max;
        console.log("Max uint96 value:        ", maxUint96);
        console.log("Max in ether (18 dec):   ", maxUint96 / 1e18);

        // Should succeed with max uint96
        address escrow = factoryPacked.createEscrow(
            ALICE,
            BOB,
            address(token),
            maxUint96,
            maxUint96
        );

        UnicitySwapEscrowImplementationPacked escrowContract = UnicitySwapEscrowImplementationPacked(payable(escrow));
        assertEq(escrowContract.swapValue(), maxUint96);
        assertEq(escrowContract.feeValue(), maxUint96);

        console.log("uint96 max values accepted");
    }

    function test_Packed_ValueLimits_ExceedsUint96() public {
        console.log("\n=== VALUE LIMITS TEST (exceeds uint96) ===");

        uint256 tooLarge = type(uint96).max + 1;

        // Should revert with value too large
        vm.expectRevert(
            abi.encodeWithSelector(
                UnicitySwapEscrowImplementationPacked.ValueTooLarge.selector,
                "swapValue"
            )
        );
        factoryPacked.createEscrow(ALICE, BOB, address(token), tooLarge, 0);

        console.log("Values exceeding uint96 rejected");
    }
}
