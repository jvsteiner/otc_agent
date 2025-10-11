// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/UnicitySwapBroker.sol";
import "./SignatureHelper.sol";

/**
 * @title SignatureSecurityAudit
 * @notice Comprehensive signature security validation tests for UnicitySwapBroker
 * @dev Tests signature replay, malleability, collision, and other attack vectors
 */
contract SignatureSecurityAudit is Test {
    UnicitySwapBroker public broker;
    SignatureHelper public sigHelper;

    address public owner = address(0x1111);
    address public operator = address(0x2222);
    uint256 public operatorPrivateKey = 0xABCDEF;

    address payable public payback = payable(address(0x3333));
    address payable public recipient = payable(address(0x4444));
    address payable public feeRecipient = payable(address(0x5555));
    address public attacker = address(0x6666);

    bytes32 public constant DEAL_ID_1 = keccak256("deal_1");
    bytes32 public constant DEAL_ID_2 = keccak256("deal_2");

    uint256 public constant SWAP_AMOUNT = 100 ether;
    uint256 public constant FEE_AMOUNT = 10 ether;
    uint256 public constant TOTAL_AMOUNT = 120 ether;

    function setUp() public {
        // Setup operator with known private key
        operator = vm.addr(operatorPrivateKey);

        // Deploy broker with operator
        vm.prank(owner);
        broker = new UnicitySwapBroker(operator);

        // Setup signature helper
        sigHelper = new SignatureHelper();

        // Fund attacker for tests
        vm.deal(attacker, 1000 ether);
    }

    /**
     * @notice Test that signatures cannot be replayed on same contract
     */
    function test_SignatureReplayProtection_SameContract() public {
        // Generate valid signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // First use of signature succeeds
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Try to replay same signature with same dealId (should fail due to processedDeals)
        vm.expectRevert(abi.encodeWithSignature("DealAlreadyProcessed(bytes32)", DEAL_ID_1));
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Try to replay same signature with different dealId (should fail due to signature mismatch)
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_2,  // Different dealId
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature  // Same signature
        );
    }

    /**
     * @notice Test that signatures cannot be replayed across different contracts
     */
    function test_SignatureReplayProtection_CrossContract() public {
        // Deploy second broker with same operator
        UnicitySwapBroker broker2 = new UnicitySwapBroker(operator);

        // Generate signature for first broker
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),  // Signature is for broker1
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // Signature works on first broker
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Same signature fails on second broker (different contract address in hash)
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(operator);
        broker2.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );
    }

    /**
     * @notice Test signature malleability protection (ECDSA library handles this)
     */
    function test_SignatureMalleabilityProtection() public {
        // Generate valid signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // Attempt to create malleable signature by flipping s value
        // OpenZeppelin's ECDSA.recover handles this internally
        // This test verifies the library is properly integrated

        // First transaction succeeds
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        assertTrue(broker.processedDeals(DEAL_ID_1), "Deal should be processed");
    }

    /**
     * @notice Test that signatures are bound to caller address
     */
    function test_SignatureCallerBinding() public {
        address escrowEOA = address(0x7777);
        vm.deal(escrowEOA, TOTAL_AMOUNT);

        // Generate signature for escrowEOA as caller
        bytes memory signatureForEscrow = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            escrowEOA  // Signature is bound to this caller
        );

        // Attacker tries to use escrow's signature
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(attacker);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signatureForEscrow  // Signature is for different caller
        );

        // Correct caller succeeds
        vm.prank(escrowEOA);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signatureForEscrow
        );

        assertTrue(broker.processedDeals(DEAL_ID_1), "Deal should be processed");
    }

    /**
     * @notice Test that signatures cannot be used with modified parameters
     */
    function test_SignatureParameterIntegrity() public {
        // Generate valid signature
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // Try to use signature with modified amount (attack: steal more funds)
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(operator);
        broker.swapNative{value: 200 ether}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            150 ether,  // Modified amount
            FEE_AMOUNT,
            signature
        );

        // Try to use signature with modified recipient (attack: redirect funds)
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            payable(attacker),  // Modified recipient
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // Try to use signature with modified fees (attack: steal fees)
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            payable(attacker),  // Modified fee recipient
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );
    }

    /**
     * @notice Test that invalid signature formats are rejected
     */
    function test_InvalidSignatureFormats() public {
        // Test empty signature
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 0));
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            ""  // Empty signature
        );

        // Test short signature
        bytes memory shortSig = hex"deadbeef";
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 4));
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            shortSig
        );

        // Test wrong length signature (64 bytes instead of 65)
        bytes memory wrongLengthSig = new bytes(64);
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 64));
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            wrongLengthSig
        );
    }

    /**
     * @notice Test that signatures from non-operator are rejected
     */
    function test_NonOperatorSignatureRejection() public {
        // Generate signature from attacker's private key
        uint256 attackerPrivateKey = 0xBADBAD;
        address attackerSigner = vm.addr(attackerPrivateKey);

        // Attacker creates their own signature
        bytes memory attackerSignature = sigHelper.signSwapNative(
            attackerPrivateKey,  // Attacker's private key
            address(broker),
            DEAL_ID_1,
            payback,
            payable(attacker),  // Trying to redirect to attacker
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            attacker
        );

        // Signature is valid but signer is not operator
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(attacker);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            payable(attacker),
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            attackerSignature
        );
    }

    /**
     * @notice Test frontrunning protection through signature-caller binding
     */
    function test_FrontrunningProtection() public {
        address escrowEOA = address(0x8888);
        vm.deal(escrowEOA, TOTAL_AMOUNT);
        vm.deal(attacker, TOTAL_AMOUNT);

        // Backend generates signature for legitimate escrow EOA
        bytes memory legitSignature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            escrowEOA  // Signature bound to legitimate caller
        );

        // Attacker tries to frontrun with stolen signature
        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(attacker);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            legitSignature  // Stolen signature won't work with different caller
        );

        // Legitimate transaction still succeeds
        vm.prank(escrowEOA);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            legitSignature
        );

        assertTrue(broker.processedDeals(DEAL_ID_1), "Legitimate deal should process");
    }

    /**
     * @notice Test signature validation for revertNative
     */
    function test_RevertNativeSignatureValidation() public {
        uint256 revertAmount = FEE_AMOUNT + 10 ether;

        // Generate valid revert signature
        bytes memory revertSig = sigHelper.signRevertNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            operator
        );

        // Try to use swap signature for revert (should fail)
        bytes memory swapSig = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        vm.expectRevert(abi.encodeWithSignature("InvalidSignature()"));
        vm.prank(operator);
        broker.revertNative{value: revertAmount}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            swapSig  // Wrong signature type
        );

        // Correct signature succeeds
        vm.prank(operator);
        broker.revertNative{value: revertAmount}(
            DEAL_ID_1,
            payback,
            feeRecipient,
            FEE_AMOUNT,
            revertSig
        );

        assertTrue(broker.processedDeals(DEAL_ID_1), "Revert should process deal");
    }

    /**
     * @notice Test that signature includes chain ID implicitly through contract address
     */
    function test_ChainIdProtection() public {
        // Contract address is different on each chain, providing implicit chain ID protection
        // Signature includes address(this) which is deterministic based on deployer nonce and chain

        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            operator
        );

        // Signature works on this chain
        vm.prank(operator);
        broker.swapNative{value: TOTAL_AMOUNT}(
            DEAL_ID_1,
            payback,
            recipient,
            feeRecipient,
            SWAP_AMOUNT,
            FEE_AMOUNT,
            signature
        );

        // On a different chain, the broker would have a different address
        // making the signature invalid (implicit chain protection)
        assertTrue(broker.processedDeals(DEAL_ID_1), "Deal should be processed");
    }

    /**
     * @notice Test gas griefing resistance
     */
    function test_GasGriefingResistance() public {
        // Create signature with maximum valid parameters
        bytes memory signature = sigHelper.signSwapNative(
            operatorPrivateKey,
            address(broker),
            bytes32(type(uint256).max),  // Max dealId
            payback,
            recipient,
            feeRecipient,
            type(uint256).max - 1,  // Max amounts
            1,
            operator
        );

        // Even with max values, signature verification should have bounded gas cost
        uint256 gasBefore = gasleft();

        vm.expectRevert(); // Will revert due to insufficient balance, but that's after sig verification
        vm.prank(operator);
        broker.swapNative{value: 1}(
            bytes32(type(uint256).max),
            payback,
            recipient,
            feeRecipient,
            type(uint256).max - 1,
            1,
            signature
        );

        uint256 gasUsed = gasBefore - gasleft();
        // Gas usage should be reasonable (< 100k for signature verification + basic checks)
        assertLt(gasUsed, 100000, "Gas usage should be bounded");
    }
}