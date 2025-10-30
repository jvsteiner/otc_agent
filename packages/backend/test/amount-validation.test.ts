/**
 * @fileoverview Test suite for amount validation security.
 * Tests comprehensive input validation to prevent security vulnerabilities.
 */

import { describe, it, expect } from 'vitest';
import { validateAmountString, validateAmounts, isValidAmount, validateAmountWithResult } from '../src/utils/validation';

describe('Amount Validation Security Tests', () => {
  describe('Valid amounts (should PASS)', () => {
    it('should accept positive integer amount', () => {
      expect(() => validateAmountString('1', 'amount')).not.toThrow();
    });

    it('should accept positive decimal amount', () => {
      expect(() => validateAmountString('1.5', 'amount')).not.toThrow();
    });

    it('should accept minimum amount (1 satoshi equivalent)', () => {
      expect(() => validateAmountString('0.00000001', 'amount')).not.toThrow();
    });

    it('should accept large amount near maximum', () => {
      expect(() => validateAmountString('999999999', 'amount')).not.toThrow();
    });

    it('should accept maximum amount', () => {
      expect(() => validateAmountString('1000000000', 'amount')).not.toThrow();
    });

    it('should accept amount with many decimal places', () => {
      expect(() => validateAmountString('1.23456789012345', 'amount')).not.toThrow();
    });

    it('should accept small fractional amount', () => {
      expect(() => validateAmountString('0.1', 'amount')).not.toThrow();
    });
  });

  describe('Invalid amounts (should FAIL)', () => {
    describe('Negative amounts', () => {
      it('should reject negative integer', () => {
        expect(() => validateAmountString('-1', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject negative decimal', () => {
        expect(() => validateAmountString('-1.5', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject negative zero', () => {
        expect(() => validateAmountString('-0', 'amount')).toThrow('amount must be a positive decimal number');
      });
    });

    describe('Zero amounts', () => {
      it('should reject zero', () => {
        expect(() => validateAmountString('0', 'amount')).toThrow('amount must be greater than zero');
      });

      it('should reject zero with decimal', () => {
        expect(() => validateAmountString('0.0', 'amount')).toThrow('amount must be greater than zero');
      });

      it('should reject zero with many decimals', () => {
        expect(() => validateAmountString('0.00000000', 'amount')).toThrow('amount must be greater than zero');
      });
    });

    describe('Non-numeric inputs', () => {
      it('should reject alphabetic string', () => {
        expect(() => validateAmountString('abc', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject alphanumeric string', () => {
        expect(() => validateAmountString('123abc', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject special characters', () => {
        expect(() => validateAmountString('!@#$', 'amount')).toThrow('amount must be a positive decimal number');
      });
    });

    describe('Scientific notation', () => {
      it('should reject scientific notation (lowercase e)', () => {
        expect(() => validateAmountString('1e18', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject scientific notation (uppercase E)', () => {
        expect(() => validateAmountString('1E18', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject negative exponent', () => {
        expect(() => validateAmountString('1e-8', 'amount')).toThrow('amount must be a positive decimal number');
      });
    });

    describe('Special values', () => {
      it('should reject Infinity', () => {
        expect(() => validateAmountString('Infinity', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject NaN', () => {
        expect(() => validateAmountString('NaN', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject null', () => {
        expect(() => validateAmountString('null', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject undefined', () => {
        expect(() => validateAmountString('undefined', 'amount')).toThrow('amount must be a positive decimal number');
      });
    });

    describe('Malformed decimal formats', () => {
      it('should reject multiple decimal points', () => {
        expect(() => validateAmountString('1.2.3', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject leading decimal without integer', () => {
        expect(() => validateAmountString('.5', 'amount')).toThrow('amount must be a positive decimal number');
      });

      it('should reject trailing decimal without fraction', () => {
        expect(() => validateAmountString('5.', 'amount')).toThrow('amount must be a positive decimal number');
      });
    });

    describe('Empty and whitespace inputs', () => {
      it('should reject empty string', () => {
        expect(() => validateAmountString('', 'amount')).toThrow('amount is required and must be a string');
      });

      it('should reject whitespace only', () => {
        expect(() => validateAmountString('   ', 'amount')).toThrow('amount cannot be empty or whitespace');
      });

      it('should reject tab character', () => {
        expect(() => validateAmountString('\t', 'amount')).toThrow('amount cannot be empty or whitespace');
      });

      it('should reject newline character', () => {
        expect(() => validateAmountString('\n', 'amount')).toThrow('amount cannot be empty or whitespace');
      });
    });

    describe('Amounts with surrounding whitespace', () => {
      it('should accept amount with leading whitespace (trimmed)', () => {
        expect(() => validateAmountString('  1.5', 'amount')).not.toThrow();
      });

      it('should accept amount with trailing whitespace (trimmed)', () => {
        expect(() => validateAmountString('1.5  ', 'amount')).not.toThrow();
      });

      it('should accept amount with surrounding whitespace (trimmed)', () => {
        expect(() => validateAmountString('  1.5  ', 'amount')).not.toThrow();
      });
    });

    describe('Boundary violations', () => {
      it('should reject amount too small (dust attack)', () => {
        expect(() => validateAmountString('0.000000001', 'amount')).toThrow('amount is too small (minimum: 0.00000001)');
      });

      it('should reject amount too large (overflow attack)', () => {
        expect(() => validateAmountString('1000000001', 'amount')).toThrow('amount is too large (maximum: 1000000000)');
      });

      it('should reject extremely large amount', () => {
        expect(() => validateAmountString('999999999999999999', 'amount')).toThrow('amount is too large (maximum: 1000000000)');
      });
    });

    describe('Type checking', () => {
      it('should reject null value', () => {
        expect(() => validateAmountString(null as any, 'amount')).toThrow('amount is required and must be a string');
      });

      it('should reject undefined value', () => {
        expect(() => validateAmountString(undefined as any, 'amount')).toThrow('amount is required and must be a string');
      });

      it('should reject number type', () => {
        expect(() => validateAmountString(123 as any, 'amount')).toThrow('amount is required and must be a string');
      });

      it('should reject object type', () => {
        expect(() => validateAmountString({} as any, 'amount')).toThrow('amount is required and must be a string');
      });
    });
  });

  describe('Custom field names', () => {
    it('should include custom field name in error message', () => {
      expect(() => validateAmountString('-1', 'alice.amount')).toThrow('alice.amount must be a positive decimal number');
    });

    it('should include custom field name for zero amount', () => {
      expect(() => validateAmountString('0', 'bob.amount')).toThrow('bob.amount must be greater than zero');
    });
  });

  describe('Batch validation with validateAmounts', () => {
    it('should validate multiple valid amounts', () => {
      expect(() => validateAmounts({
        'alice.amount': '1.5',
        'bob.amount': '100.25'
      })).not.toThrow();
    });

    it('should reject batch with one invalid amount', () => {
      expect(() => validateAmounts({
        'alice.amount': '1.5',
        'bob.amount': '-100'
      })).toThrow('bob.amount must be a positive decimal number');
    });

    it('should reject batch with multiple invalid amounts (fails on first)', () => {
      expect(() => validateAmounts({
        'alice.amount': '-1',
        'bob.amount': '0'
      })).toThrow('alice.amount must be a positive decimal number');
    });
  });

  describe('isValidAmount helper function', () => {
    it('should return true for valid amount', () => {
      expect(isValidAmount('1.5')).toBe(true);
    });

    it('should return false for invalid amount', () => {
      expect(isValidAmount('-1')).toBe(false);
    });

    it('should return false for non-numeric input', () => {
      expect(isValidAmount('abc')).toBe(false);
    });

    it('should return false for zero', () => {
      expect(isValidAmount('0')).toBe(false);
    });
  });

  describe('validateAmountWithResult helper function', () => {
    it('should return success for valid amount', () => {
      const result = validateAmountWithResult('1.5', 'amount');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return error for invalid amount', () => {
      const result = validateAmountWithResult('-1', 'amount');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('amount must be a positive decimal number (e.g., "1" or "1.5")');
    });

    it('should return error for zero amount', () => {
      const result = validateAmountWithResult('0', 'amount');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('amount must be greater than zero');
    });

    it('should include custom field name in error', () => {
      const result = validateAmountWithResult('abc', 'alice.amount');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('alice.amount');
    });
  });

  describe('Edge cases and attack vectors', () => {
    it('should reject hexadecimal notation', () => {
      expect(() => validateAmountString('0x10', 'amount')).toThrow('amount must be a positive decimal number');
    });

    it('should reject octal notation', () => {
      expect(() => validateAmountString('0o10', 'amount')).toThrow('amount must be a positive decimal number');
    });

    it('should reject binary notation', () => {
      expect(() => validateAmountString('0b10', 'amount')).toThrow('amount must be a positive decimal number');
    });

    it('should reject comma separators', () => {
      expect(() => validateAmountString('1,000', 'amount')).toThrow('amount must be a positive decimal number');
    });

    it('should reject currency symbols', () => {
      expect(() => validateAmountString('$100', 'amount')).toThrow('amount must be a positive decimal number');
      expect(() => validateAmountString('€100', 'amount')).toThrow('amount must be a positive decimal number');
    });

    it('should reject plus sign prefix', () => {
      expect(() => validateAmountString('+100', 'amount')).toThrow('amount must be a positive decimal number');
    });

    it('should reject percentage notation', () => {
      expect(() => validateAmountString('50%', 'amount')).toThrow('amount must be a positive decimal number');
    });
  });
});
