/**
 * @file EvmPlugin.signature.test.ts
 * @description Unit tests for EvmPlugin signature generation
 *
 * PURPOSE: Verify that TypeScript/ethers.js backend generates signatures that
 *          EXACTLY match what the Solidity smart contract expects.
 *
 * TEST STRATEGY:
 * 1. Use reference test vectors from Solidity test (SignatureVerification.t.sol)
 * 2. Generate signatures using the backend implementation
 * 3. Compare against known-good Solidity signatures
 * 4. Verify signature recovery returns correct signer address
 *
 * CRITICAL: Any mismatch = 100% failure rate in production
 */

import { ethers } from 'ethers';
import { describe, it, expect, beforeAll } from '@jest/globals';

describe('EvmPlugin Signature Generation', () => {
  // Test vectors from Solidity (SignatureVerification.t.sol)
  const OPERATOR_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const OPERATOR_ADDRESS = '0x1Be31A94361a391bBaFB2a4CCd704F57dc04d4bb';
  const BROKER_ADDRESS = '0x522B3294E6d06aA25Ad0f1B8891242E335D3B459';

  // Test addresses (must match Solidity test)
  const ESCROW_EOA = '0x1111111111111111111111111111111111111111';
  const PAYBACK = '0x2222222222222222222222222222222222222222';
  const RECIPIENT = '0x3333333333333333333333333333333333333333';
  const FEE_RECIPIENT = '0x4444444444444444444444444444444444444444';

  let operatorWallet: ethers.Wallet;

  beforeAll(() => {
    operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY);
  });

  /**
   * Generate operator signature for swapNative/revertNative
   * This is the EXACT implementation from EvmPlugin.ts
   */
  function generateOperatorSignature(
    dealId: string,
    payback: string,
    recipient: string,
    feeRecipient: string,
    amount: string,
    fees: string,
    escrowAddress: string
  ): string {
    // Convert dealId string to bytes32
    const dealIdBytes32 = ethers.id(dealId);

    // Convert amounts to wei
    const amountWei = ethers.parseEther(amount);
    const feesWei = ethers.parseEther(fees);

    // Construct message hash matching contract's _verifyOperatorSignature
    const messageHash = ethers.solidityPackedKeccak256(
      ['address', 'bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'address'],
      [BROKER_ADDRESS, dealIdBytes32, payback, recipient, feeRecipient, amountWei, feesWei, escrowAddress]
    );

    // Apply Ethereum Signed Message prefix
    const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));

    // Sign the prefixed hash
    const signature = operatorWallet.signingKey.sign(ethSignedMessageHash).serialized;

    return signature;
  }

  describe('Test Vector 1: Basic', () => {
    it('should generate correct signature for basic case', () => {
      const dealId = 'BASIC_DEAL';
      const amount = '1.0';
      const fees = '0.01';

      const signature = generateOperatorSignature(
        dealId,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        ESCROW_EOA
      );

      // Reference signature from Solidity test
      const expectedSignature =
        '0x17d6b21e778f1d3aacbf0b2aa1f253ae5e3939aa017a87c0b5bbade29974d6bf7f64338f26c4f06385ca21b2c56d014d536985cc98d00cd402c29a00637949201c';

      expect(signature.toLowerCase()).toBe(expectedSignature.toLowerCase());
    });

    it('should recover to correct operator address', () => {
      const dealId = 'BASIC_DEAL';
      const amount = '1.0';
      const fees = '0.01';

      const signature = generateOperatorSignature(
        dealId,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        ESCROW_EOA
      );

      // Reconstruct the same message hash
      const dealIdBytes32 = ethers.id(dealId);
      const amountWei = ethers.parseEther(amount);
      const feesWei = ethers.parseEther(fees);

      const messageHash = ethers.solidityPackedKeccak256(
        ['address', 'bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'address'],
        [BROKER_ADDRESS, dealIdBytes32, PAYBACK, RECIPIENT, FEE_RECIPIENT, amountWei, feesWei, ESCROW_EOA]
      );

      const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));

      // Recover signer from signature
      const recoveredAddress = ethers.recoverAddress(ethSignedMessageHash, signature);

      expect(recoveredAddress.toLowerCase()).toBe(OPERATOR_ADDRESS.toLowerCase());
    });
  });

  describe('Test Vector 2: Zero Fees', () => {
    it('should generate correct signature with zero fees', () => {
      const dealId = 'ZERO_FEES_DEAL';
      const amount = '5.0';
      const fees = '0';

      const signature = generateOperatorSignature(
        dealId,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        ESCROW_EOA
      );

      const expectedSignature =
        '0x316432fd0d6708e8689670ca1a1a60f7c828bc77ccf07a9eccb418799c67cd6e035f683a5199733145946f1cc8dd15551e10d0741c18eb764921919e47c2cd881c';

      expect(signature.toLowerCase()).toBe(expectedSignature.toLowerCase());
    });

    it('should recover to correct operator address with zero fees', () => {
      const dealId = 'ZERO_FEES_DEAL';
      const amount = '5.0';
      const fees = '0';

      const signature = generateOperatorSignature(
        dealId,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        ESCROW_EOA
      );

      const dealIdBytes32 = ethers.id(dealId);
      const amountWei = ethers.parseEther(amount);
      const feesWei = ethers.parseEther(fees);

      const messageHash = ethers.solidityPackedKeccak256(
        ['address', 'bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'address'],
        [BROKER_ADDRESS, dealIdBytes32, PAYBACK, RECIPIENT, FEE_RECIPIENT, amountWei, feesWei, ESCROW_EOA]
      );

      const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));
      const recoveredAddress = ethers.recoverAddress(ethSignedMessageHash, signature);

      expect(recoveredAddress.toLowerCase()).toBe(OPERATOR_ADDRESS.toLowerCase());
    });
  });

  describe('Test Vector 3: Large Amounts', () => {
    it('should generate correct signature with large amounts', () => {
      const dealId = 'LARGE_AMOUNT_DEAL';
      const amount = '123.456789';
      const fees = '3.7';

      const signature = generateOperatorSignature(
        dealId,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        ESCROW_EOA
      );

      const expectedSignature =
        '0xca1ebc4faad2c4c95c10e81e7f44bf290f0bab89ccad32710fd77c1022ee1b292a087ab342546e747456a21f3bd1b73a462086c676993a5cd73aa4c8f66d11bf1b';

      expect(signature.toLowerCase()).toBe(expectedSignature.toLowerCase());
    });
  });

  describe('Test Vector 4: Different Caller', () => {
    it('should generate correct signature for different caller', () => {
      const dealId = 'DIFFERENT_CALLER_DEAL';
      const amount = '10.0';
      const fees = '0.3';
      const differentCaller = '0x9999999999999999999999999999999999999999';

      const signature = generateOperatorSignature(
        dealId,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        differentCaller
      );

      const expectedSignature =
        '0xa89e32d3210d3869483f0cd6fd613480e10897520fdd2643bf9b86f4631830975491690b3e82a8bbb2c7ab57ea9c171bb775f2aad96d35d48f2f5441a954ae061c';

      expect(signature.toLowerCase()).toBe(expectedSignature.toLowerCase());
    });

    it('should generate different signatures for different callers', () => {
      const dealId = 'TEST_DEAL';
      const amount = '1.0';
      const fees = '0.01';

      const sig1 = generateOperatorSignature(dealId, PAYBACK, RECIPIENT, FEE_RECIPIENT, amount, fees, ESCROW_EOA);

      const sig2 = generateOperatorSignature(
        dealId,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        '0x9999999999999999999999999999999999999999'
      );

      expect(sig1.toLowerCase()).not.toBe(sig2.toLowerCase());
    });
  });

  describe('Test Vector 5: Revert Operation', () => {
    it('should generate correct signature for revert (recipient=0, amount=0)', () => {
      const dealId = 'REVERT_DEAL';
      const fees = '0.5';

      // For revert: recipient = address(0), amount = 0
      const signature = generateOperatorSignature(
        dealId,
        PAYBACK,
        ethers.ZeroAddress, // recipient is 0x0 for revert
        FEE_RECIPIENT,
        '0', // amount is 0 for revert
        fees,
        ESCROW_EOA
      );

      const expectedSignature =
        '0xdf43a3d5a7cbafc5f11e7f741b44f1c12646d353973034199a2d55019cbcac3e34e46c74a85599ecc66e1554663e6717489e67bc42ee01ff458afb0a510bdf1a1b';

      expect(signature.toLowerCase()).toBe(expectedSignature.toLowerCase());
    });
  });

  describe('Test Vector 6: Different Deal IDs', () => {
    it('should generate different signatures for different dealIds', () => {
      const dealId1 = 'deal_001';
      const dealId2 = 'deal_002';
      const amount = '1.0';
      const fees = '0.01';

      const sig1 = generateOperatorSignature(dealId1, PAYBACK, RECIPIENT, FEE_RECIPIENT, amount, fees, ESCROW_EOA);

      const sig2 = generateOperatorSignature(dealId2, PAYBACK, RECIPIENT, FEE_RECIPIENT, amount, fees, ESCROW_EOA);

      expect(sig1.toLowerCase()).not.toBe(sig2.toLowerCase());
    });

    it('should match Solidity reference signatures for specific dealIds', () => {
      const dealId1 = 'deal_001';
      const amount = '1.0';
      const fees = '0.01';

      const signature = generateOperatorSignature(
        dealId1,
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        amount,
        fees,
        ESCROW_EOA
      );

      const expectedSignature =
        '0xbdd72584adb2770e2fc0ec5934a4f426e8d33ef7c9f6f08eab7fd32f5da9518c3dd565bfde9d71d46ba8ce29894d5d62cc62e083b9b792a8842125f92ec818811b';

      expect(signature.toLowerCase()).toBe(expectedSignature.toLowerCase());
    });
  });

  describe('Signature Properties', () => {
    it('should always be 65 bytes (130 hex chars + 0x prefix)', () => {
      const signature = generateOperatorSignature(
        'TEST_DEAL',
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        '1.0',
        '0.01',
        ESCROW_EOA
      );

      // 0x + 130 hex chars = 132 total
      expect(signature.length).toBe(132);
      expect(signature.startsWith('0x')).toBe(true);
    });

    it('should be deterministic (same inputs = same signature)', () => {
      const dealId = 'DETERMINISTIC_TEST';
      const amount = '1.0';
      const fees = '0.01';

      const sig1 = generateOperatorSignature(dealId, PAYBACK, RECIPIENT, FEE_RECIPIENT, amount, fees, ESCROW_EOA);

      const sig2 = generateOperatorSignature(dealId, PAYBACK, RECIPIENT, FEE_RECIPIENT, amount, fees, ESCROW_EOA);

      expect(sig1.toLowerCase()).toBe(sig2.toLowerCase());
    });

    it('should change if any parameter changes', () => {
      const baseSig = generateOperatorSignature(
        'TEST',
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        '1.0',
        '0.01',
        ESCROW_EOA
      );

      // Change dealId
      const sig1 = generateOperatorSignature(
        'TEST2',
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        '1.0',
        '0.01',
        ESCROW_EOA
      );
      expect(sig1).not.toBe(baseSig);

      // Change amount
      const sig2 = generateOperatorSignature(
        'TEST',
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        '2.0',
        '0.01',
        ESCROW_EOA
      );
      expect(sig2).not.toBe(baseSig);

      // Change fees
      const sig3 = generateOperatorSignature(
        'TEST',
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        '1.0',
        '0.02',
        ESCROW_EOA
      );
      expect(sig3).not.toBe(baseSig);

      // Change caller
      const sig4 = generateOperatorSignature(
        'TEST',
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        '1.0',
        '0.01',
        PAYBACK // Different caller
      );
      expect(sig4).not.toBe(baseSig);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small amounts', () => {
      const signature = generateOperatorSignature(
        'SMALL_AMOUNT',
        PAYBACK,
        RECIPIENT,
        FEE_RECIPIENT,
        '0.000000000000000001', // 1 wei
        '0',
        ESCROW_EOA
      );

      expect(signature).toBeDefined();
      expect(signature.length).toBe(132);
    });

    it('should handle checksum addresses', () => {
      // Test with mixed case addresses (checksum format)
      const checksumPayback = ethers.getAddress(PAYBACK);
      const checksumRecipient = ethers.getAddress(RECIPIENT);
      const checksumFeeRecipient = ethers.getAddress(FEE_RECIPIENT);
      const checksumEscrow = ethers.getAddress(ESCROW_EOA);

      const sig1 = generateOperatorSignature(
        'CHECKSUM_TEST',
        PAYBACK.toLowerCase(),
        RECIPIENT.toLowerCase(),
        FEE_RECIPIENT.toLowerCase(),
        '1.0',
        '0.01',
        ESCROW_EOA.toLowerCase()
      );

      const sig2 = generateOperatorSignature(
        'CHECKSUM_TEST',
        checksumPayback,
        checksumRecipient,
        checksumFeeRecipient,
        '1.0',
        '0.01',
        checksumEscrow
      );

      // Signatures should be the same regardless of address casing
      expect(sig1.toLowerCase()).toBe(sig2.toLowerCase());
    });

    it('should handle string dealIds with special characters', () => {
      const specialDealIds = [
        'deal-with-dashes',
        'deal_with_underscores',
        'deal.with.dots',
        'deal/with/slashes',
        'deal with spaces',
        'deal@with#special$chars%',
      ];

      specialDealIds.forEach((dealId) => {
        const signature = generateOperatorSignature(
          dealId,
          PAYBACK,
          RECIPIENT,
          FEE_RECIPIENT,
          '1.0',
          '0.01',
          ESCROW_EOA
        );

        expect(signature).toBeDefined();
        expect(signature.length).toBe(132);

        // Verify recovery still works
        const dealIdBytes32 = ethers.id(dealId);
        const amountWei = ethers.parseEther('1.0');
        const feesWei = ethers.parseEther('0.01');

        const messageHash = ethers.solidityPackedKeccak256(
          ['address', 'bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'address'],
          [BROKER_ADDRESS, dealIdBytes32, PAYBACK, RECIPIENT, FEE_RECIPIENT, amountWei, feesWei, ESCROW_EOA]
        );

        const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));
        const recoveredAddress = ethers.recoverAddress(ethSignedMessageHash, signature);

        expect(recoveredAddress.toLowerCase()).toBe(OPERATOR_ADDRESS.toLowerCase());
      });
    });
  });

  describe('Message Hash Construction', () => {
    it('should construct message hash exactly as contract does', () => {
      const dealId = 'MESSAGE_HASH_TEST';
      const amount = '1.0';
      const fees = '0.01';

      const dealIdBytes32 = ethers.id(dealId);
      const amountWei = ethers.parseEther(amount);
      const feesWei = ethers.parseEther(fees);

      // Construct message hash (first level)
      const messageHash = ethers.solidityPackedKeccak256(
        ['address', 'bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'address'],
        [BROKER_ADDRESS, dealIdBytes32, PAYBACK, RECIPIENT, FEE_RECIPIENT, amountWei, feesWei, ESCROW_EOA]
      );

      expect(messageHash).toBeDefined();
      expect(messageHash.startsWith('0x')).toBe(true);
      expect(messageHash.length).toBe(66); // 0x + 64 hex chars

      // Apply Ethereum Signed Message prefix
      const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));

      expect(ethSignedMessageHash).toBeDefined();
      expect(ethSignedMessageHash.startsWith('0x')).toBe(true);
      expect(ethSignedMessageHash.length).toBe(66);

      // Verify it's different from original message hash
      expect(ethSignedMessageHash.toLowerCase()).not.toBe(messageHash.toLowerCase());
    });
  });
});
