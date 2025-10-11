// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/UnicitySwapBroker.sol";
import "./SignatureHelper.sol";

/**
 * @title SignatureVerificationTest
 * @notice Comprehensive test suite to verify signature generation matches contract verification
 * @dev This test provides reference signatures and test vectors for TypeScript tests
 *
 * PURPOSE: Ensure that backend (TypeScript/ethers.js) generates signatures that
 *          the smart contract (Solidity) will accept. Any mismatch = 100% failure rate.
 *
 * TEST STRATEGY:
 * 1. Generate signatures using Foundry's vm.sign() with known test vectors
 * 2. Verify these signatures work with the actual contract
 * 3. Export test vectors for TypeScript to validate against
 * 4. Cover multiple scenarios (basic, zero values, large amounts, edge cases)
 */
contract SignatureVerificationTest is Test {
    UnicitySwapBroker public broker;
    SignatureHelper public sigHelper;

    // Test operator keys and addresses
    address public owner = address(0x1);
    uint256 public operatorPrivateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address public operator;

    // Test addresses (deterministic for cross-test compatibility)
    address public escrowEOA = address(0x1111111111111111111111111111111111111111);
    address payable public payback = payable(address(0x2222222222222222222222222222222222222222));
    address payable public recipient = payable(address(0x3333333333333333333333333333333333333333));
    address payable public feeRecipient = payable(address(0x4444444444444444444444444444444444444444));

    // Test vectors for cross-verification
    struct TestVector {
        string name;
        bytes32 dealId;
        address payback;
        address recipient;
        address feeRecipient;
        uint256 amount;
        uint256 fees;
        address caller;
        bytes signature;
    }

    TestVector[] public testVectors;

    function setUp() public {
        // Derive operator address from private key
        operator = vm.addr(operatorPrivateKey);

        vm.startPrank(owner);
        broker = new UnicitySwapBroker(operator);
        sigHelper = new SignatureHelper();
        vm.stopPrank();

        // Fund test accounts
        vm.deal(escrowEOA, 100000 ether);
        vm.deal(operator, 100000 ether);
    }

    /*//////////////////////////////////////////////////////////////
                    TEST VECTOR GENERATION TESTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Test Case 1: Basic signature with round numbers
     * @dev This is the simplest case - verifies basic signature generation
     */
    function test_SignatureVector_Basic() public {
        bytes32 dealId = keccak256("BASIC_DEAL");
        uint256 amount = 1 ether;
        uint256 fees = 0.01 ether;
        uint256 totalAmount = 1.5 ether; // amount + fees + surplus

        // Generate signature using SignatureHelper
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        // Store test vector
        testVectors.push(TestVector({
            name: "Basic",
            dealId: dealId,
            payback: payback,
            recipient: recipient,
            feeRecipient: feeRecipient,
            amount: amount,
            fees: fees,
            caller: escrowEOA,
            signature: signature
        }));

        // Verify signature works with contract
        vm.prank(escrowEOA);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            signature
        );

        assertTrue(broker.processedDeals(dealId), "Deal should be processed");
        assertEq(recipient.balance, amount, "Recipient should receive amount");
        assertEq(feeRecipient.balance, fees, "Fee recipient should receive fees");

        // Log for TypeScript reference
        console.log("=== TEST VECTOR 1: BASIC ===");
        console.log("Broker Address:", address(broker));
        console.log("Deal ID:");
        console.logBytes32(dealId);
        console.log("Payback:", payback);
        console.log("Recipient:", recipient);
        console.log("Fee Recipient:", feeRecipient);
        console.log("Amount:", amount);
        console.log("Fees:", fees);
        console.log("Caller (Escrow EOA):", escrowEOA);
        console.log("Signature:");
        console.logBytes(signature);
        console.log("Operator Address:", operator);
        console.log("===========================\n");
    }

    /**
     * @notice Test Case 2: Zero fees
     * @dev Tests signature when fees = 0
     */
    function test_SignatureVector_ZeroFees() public {
        bytes32 dealId = keccak256("ZERO_FEES_DEAL");
        uint256 amount = 5 ether;
        uint256 fees = 0;
        uint256 totalAmount = 5.25 ether;

        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        testVectors.push(TestVector({
            name: "ZeroFees",
            dealId: dealId,
            payback: payback,
            recipient: recipient,
            feeRecipient: feeRecipient,
            amount: amount,
            fees: fees,
            caller: escrowEOA,
            signature: signature
        }));

        vm.prank(escrowEOA);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            signature
        );

        assertTrue(broker.processedDeals(dealId));

        console.log("=== TEST VECTOR 2: ZERO FEES ===");
        console.log("Deal ID:");
        console.logBytes32(dealId);
        console.log("Amount:", amount);
        console.log("Fees:", fees);
        console.log("Signature:");
        console.logBytes(signature);
        console.log("===========================\n");
    }

    /**
     * @notice Test Case 3: Large amounts
     * @dev Tests signature with realistic large ETH amounts
     */
    function test_SignatureVector_LargeAmounts() public {
        bytes32 dealId = keccak256("LARGE_AMOUNT_DEAL");
        uint256 amount = 123.456789 ether;
        uint256 fees = 3.7 ether;
        uint256 totalAmount = 130 ether;

        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        testVectors.push(TestVector({
            name: "LargeAmounts",
            dealId: dealId,
            payback: payback,
            recipient: recipient,
            feeRecipient: feeRecipient,
            amount: amount,
            fees: fees,
            caller: escrowEOA,
            signature: signature
        }));

        vm.prank(escrowEOA);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            signature
        );

        assertTrue(broker.processedDeals(dealId));

        console.log("=== TEST VECTOR 3: LARGE AMOUNTS ===");
        console.log("Deal ID:");
        console.logBytes32(dealId);
        console.log("Amount:", amount);
        console.log("Fees:", fees);
        console.log("Signature:");
        console.logBytes(signature);
        console.log("===========================\n");
    }

    /**
     * @notice Test Case 4: Different caller addresses
     * @dev Signature includes msg.sender - different callers need different signatures
     */
    function test_SignatureVector_DifferentCallers() public {
        bytes32 dealId = keccak256("DIFFERENT_CALLER_DEAL");
        uint256 amount = 10 ether;
        uint256 fees = 0.3 ether;
        uint256 totalAmount = 11 ether;

        address differentCaller = address(0x9999999999999999999999999999999999999999);
        vm.deal(differentCaller, totalAmount);

        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            differentCaller  // Different caller
        );

        testVectors.push(TestVector({
            name: "DifferentCaller",
            dealId: dealId,
            payback: payback,
            recipient: recipient,
            feeRecipient: feeRecipient,
            amount: amount,
            fees: fees,
            caller: differentCaller,
            signature: signature
        }));

        vm.prank(differentCaller);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            signature
        );

        assertTrue(broker.processedDeals(dealId));

        console.log("=== TEST VECTOR 4: DIFFERENT CALLER ===");
        console.log("Deal ID:");
        console.logBytes32(dealId);
        console.log("Caller:", differentCaller);
        console.log("Amount:", amount);
        console.log("Fees:", fees);
        console.log("Signature:");
        console.logBytes(signature);
        console.log("===========================\n");
    }

    /**
     * @notice Test Case 5: Revert operation (recipient=0, amount=0)
     * @dev Tests signature generation for revert operations
     */
    function test_SignatureVector_Revert() public {
        bytes32 dealId = keccak256("REVERT_DEAL");
        uint256 fees = 0.5 ether;
        uint256 totalAmount = 2 ether;

        bytes memory signature = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            feeRecipient,
            fees,
            escrowEOA
        );

        vm.prank(escrowEOA);
        broker.revertNative{value: totalAmount}(
            dealId,
            payback,
            feeRecipient,
            fees,
            signature
        );

        assertTrue(broker.processedDeals(dealId));

        console.log("=== TEST VECTOR 5: REVERT ===");
        console.log("Deal ID:");
        console.logBytes32(dealId);
        console.log("Fees:", fees);
        console.log("Signature:");
        console.logBytes(signature);
        console.log("Note: For revert, recipient=address(0), amount=0");
        console.log("===========================\n");
    }

    /**
     * @notice Test Case 6: Different deal IDs
     * @dev Tests that different dealIds produce different signatures
     */
    function test_SignatureVector_DifferentDealIds() public {
        string memory dealString1 = "deal_001";
        string memory dealString2 = "deal_002";

        bytes32 dealId1 = keccak256(bytes(dealString1));
        bytes32 dealId2 = keccak256(bytes(dealString2));

        uint256 amount = 1 ether;
        uint256 fees = 0.01 ether;

        bytes memory sig1 = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId1,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        bytes memory sig2 = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId2,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        // Signatures should be different
        assertFalse(keccak256(sig1) == keccak256(sig2), "Different dealIds should produce different signatures");

        console.log("=== TEST VECTOR 6: DIFFERENT DEAL IDs ===");
        console.log("Deal ID 1:");
        console.logBytes32(dealId1);
        console.log("Signature 1:");
        console.logBytes(sig1);
        console.log("Deal ID 2:");
        console.logBytes32(dealId2);
        console.log("Signature 2:");
        console.logBytes(sig2);
        console.log("===========================\n");
    }

    /*//////////////////////////////////////////////////////////////
                    SIGNATURE VERIFICATION TESTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Test that wrong caller cannot use signature
     * @dev Signature is bound to msg.sender - prevents frontrunning
     */
    function test_SignatureVerification_WrongCallerFails() public {
        bytes32 dealId = keccak256("WRONG_CALLER_TEST");
        uint256 amount = 1 ether;
        uint256 fees = 0.01 ether;
        uint256 totalAmount = 1.5 ether;

        // Generate signature for escrowEOA
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        // Try to use with different caller
        address wrongCaller = address(0x8888);
        vm.deal(wrongCaller, totalAmount);

        vm.expectRevert(UnicitySwapBroker.InvalidSignature.selector);
        vm.prank(wrongCaller);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            signature
        );
    }

    /**
     * @notice Test that modified parameters fail verification
     * @dev Signature binds all parameters - prevents parameter manipulation
     */
    function test_SignatureVerification_ModifiedParametersFail() public {
        bytes32 dealId = keccak256("MODIFIED_PARAMS_TEST");
        uint256 amount = 1 ether;
        uint256 fees = 0.01 ether;
        uint256 totalAmount = 2 ether;

        // Generate signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        // Try with modified amount (attacker tries to increase payout)
        uint256 modifiedAmount = 2 ether;

        vm.expectRevert(UnicitySwapBroker.InvalidSignature.selector);
        vm.prank(escrowEOA);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            modifiedAmount,  // Modified!
            fees,
            signature
        );
    }

    /**
     * @notice Test that signature from wrong private key fails
     * @dev Only operator's signature is valid
     */
    function test_SignatureVerification_WrongOperatorFails() public {
        bytes32 dealId = keccak256("WRONG_OPERATOR_TEST");
        uint256 amount = 1 ether;
        uint256 fees = 0.01 ether;
        uint256 totalAmount = 1.5 ether;

        // Generate signature with different private key
        uint256 wrongPrivateKey = 0x9999999999999999999999999999999999999999999999999999999999999999;

        bytes memory wrongSignature = sigHelper.signSwapNative(
            wrongPrivateKey,  // Wrong key!
            address(broker),
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            escrowEOA
        );

        vm.expectRevert(UnicitySwapBroker.InvalidSignature.selector);
        vm.prank(escrowEOA);
        broker.swapNative{value: totalAmount}(
            dealId,
            payback,
            recipient,
            feeRecipient,
            amount,
            fees,
            wrongSignature
        );
    }

    /*//////////////////////////////////////////////////////////////
                    SIGNATURE RECOVERY TESTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Test manual signature recovery
     * @dev Demonstrates the exact signature verification flow
     */
    function test_SignatureRecovery_Manual() public view {
        bytes32 dealId = keccak256("RECOVERY_TEST");
        uint256 amount = 1 ether;
        uint256 fees = 0.01 ether;

        // Step 1: Construct message hash (exactly as contract does)
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                address(broker),
                dealId,
                payback,
                recipient,
                feeRecipient,
                amount,
                fees,
                escrowEOA
            )
        );

        // Step 2: Apply Ethereum signed message prefix
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                messageHash
            )
        );

        // Step 3: Sign with operator's private key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPrivateKey, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Step 4: Recover signer from signature
        address recoveredSigner = ECDSA.recover(ethSignedMessageHash, signature);

        // Verify recovered signer matches operator
        assertEq(recoveredSigner, operator, "Recovered signer should be operator");

        console.log("=== SIGNATURE RECOVERY TEST ===");
        console.log("Message Hash:");
        console.logBytes32(messageHash);
        console.log("Eth Signed Message Hash:");
        console.logBytes32(ethSignedMessageHash);
        console.log("Operator:", operator);
        console.log("Recovered Signer:", recoveredSigner);
        console.log("Match:", recoveredSigner == operator);
        console.log("===========================\n");
    }

    /*//////////////////////////////////////////////////////////////
                    EXPORT TEST VECTORS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Export all test vectors for TypeScript
     * @dev Run this test to get complete test vectors for cross-verification
     */
    function test_ExportAllTestVectors() public {
        console.log("\n=== EXPORTING ALL TEST VECTORS ===");
        console.log("Use these values in TypeScript tests to verify signature generation");
        console.log("\nOperator Private Key (for TypeScript):");
        console.log("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
        console.log("\nOperator Address:");
        console.log(operator);
        console.log("\nTest Addresses:");
        console.log("Escrow EOA:", escrowEOA);
        console.log("Payback:", payback);
        console.log("Recipient:", recipient);
        console.log("Fee Recipient:", feeRecipient);
        console.log("===========================\n");

        // Run all test vector generation tests
        test_SignatureVector_Basic();
        test_SignatureVector_ZeroFees();
        test_SignatureVector_LargeAmounts();
        test_SignatureVector_DifferentCallers();
        test_SignatureVector_Revert();
        test_SignatureVector_DifferentDealIds();
    }
}
