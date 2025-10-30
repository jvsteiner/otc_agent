/**
 * @fileoverview Input validation utilities for RPC server.
 * This module provides comprehensive validation for amount fields to prevent
 * security vulnerabilities including negative amounts, zero amounts, malformed inputs,
 * scientific notation, and other attack vectors.
 */

import { Decimal } from '@otc-broker/core';

/**
 * Minimum allowed amount (1 satoshi equivalent = 0.00000001)
 * This prevents dust attacks and ensures economically viable transactions.
 */
const MIN_AMOUNT = '0.00000001';

/**
 * Maximum allowed amount (1 billion)
 * This prevents overflow attacks and unrealistic transaction amounts.
 */
const MAX_AMOUNT = '1000000000';

/**
 * Regular expression for validating amount string format.
 * Matches positive decimal numbers with optional fractional part.
 * Examples:
 *   - "1" (valid)
 *   - "1.5" (valid)
 *   - "0.00000001" (valid)
 *   - "-1" (invalid - negative)
 *   - "1.2.3" (invalid - multiple decimals)
 *   - "1e18" (invalid - scientific notation)
 *   - "abc" (invalid - non-numeric)
 */
const AMOUNT_REGEX = /^\d+(\.\d+)?$/;

/**
 * Validates an amount string for security and format correctness.
 * This function protects against:
 * - Negative amounts
 * - Zero amounts
 * - Non-numeric inputs (abc, NaN, Infinity)
 * - Scientific notation (1e18)
 * - Multiple decimal points (1.2.3)
 * - Whitespace-only strings
 * - Empty strings
 * - Amounts that are too small (dust attacks)
 * - Amounts that are too large (overflow attacks)
 *
 * @param amount - The amount string to validate
 * @param fieldName - The name of the field being validated (for error messages)
 * @throws Error if validation fails with a descriptive message
 *
 * @example
 * // Valid amounts - no error thrown
 * validateAmountString("1", "alice.amount");
 * validateAmountString("1.5", "bob.amount");
 * validateAmountString("0.00000001", "amount");
 * validateAmountString("999999999", "amount");
 *
 * @example
 * // Invalid amounts - throws Error
 * validateAmountString("-1", "amount");        // Error: amount must be a positive decimal number
 * validateAmountString("0", "amount");         // Error: amount must be greater than zero
 * validateAmountString("abc", "amount");       // Error: amount must be a positive decimal number
 * validateAmountString("1e18", "amount");      // Error: amount must be a positive decimal number
 * validateAmountString("0.000000001", "amount"); // Error: amount is too small (minimum: 0.00000001)
 */
export function validateAmountString(amount: string, fieldName: string = 'amount'): void {
  // Check for null, undefined, or empty string
  if (!amount || typeof amount !== 'string') {
    throw new Error(`${fieldName} is required and must be a string`);
  }

  // Trim whitespace and check if empty
  const trimmedAmount = amount.trim();
  if (trimmedAmount.length === 0) {
    throw new Error(`${fieldName} cannot be empty or whitespace`);
  }

  // Validate format using regex (rejects negative, scientific notation, multiple decimals, etc.)
  if (!AMOUNT_REGEX.test(trimmedAmount)) {
    throw new Error(`${fieldName} must be a positive decimal number (e.g., "1" or "1.5")`);
  }

  // Parse to Decimal for numeric validation
  let decimal: Decimal;
  try {
    decimal = new Decimal(trimmedAmount);
  } catch (error) {
    throw new Error(`${fieldName} is not a valid decimal number`);
  }

  // Check for special values that might pass regex but are invalid
  if (!decimal.isFinite()) {
    throw new Error(`${fieldName} must be a finite number`);
  }

  // Validate not zero or negative
  if (decimal.lte(0)) {
    throw new Error(`${fieldName} must be greater than zero`);
  }

  // Validate minimum amount (prevent dust attacks)
  const minDecimal = new Decimal(MIN_AMOUNT);
  if (decimal.lt(minDecimal)) {
    throw new Error(`${fieldName} is too small (minimum: ${MIN_AMOUNT})`);
  }

  // Validate maximum amount (prevent overflow)
  const maxDecimal = new Decimal(MAX_AMOUNT);
  if (decimal.gt(maxDecimal)) {
    throw new Error(`${fieldName} is too large (maximum: ${MAX_AMOUNT})`);
  }
}

/**
 * Validates multiple amount fields in a batch.
 * Useful for validating all amounts in a deal at once.
 *
 * @param amounts - Object mapping field names to amount strings
 * @throws Error if any validation fails
 *
 * @example
 * validateAmounts({
 *   'alice.amount': '1.5',
 *   'bob.amount': '100.25'
 * });
 */
export function validateAmounts(amounts: Record<string, string>): void {
  for (const [fieldName, amount] of Object.entries(amounts)) {
    validateAmountString(amount, fieldName);
  }
}

/**
 * Checks if an amount string is valid without throwing an error.
 * Useful for conditional validation or UI validation feedback.
 *
 * @param amount - The amount string to check
 * @returns true if valid, false if invalid
 *
 * @example
 * if (isValidAmount("1.5")) {
 *   // proceed with valid amount
 * }
 */
export function isValidAmount(amount: string): boolean {
  try {
    validateAmountString(amount);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Validates an amount and returns validation result with error message.
 * Useful for providing user-friendly validation feedback without exceptions.
 *
 * @param amount - The amount string to validate
 * @param fieldName - The name of the field being validated
 * @returns Object with isValid boolean and optional error message
 *
 * @example
 * const result = validateAmountWithResult("abc", "amount");
 * if (!result.isValid) {
 *   console.error(result.error); // "amount must be a positive decimal number"
 * }
 */
export function validateAmountWithResult(
  amount: string,
  fieldName: string = 'amount'
): { isValid: boolean; error?: string } {
  try {
    validateAmountString(amount, fieldName);
    return { isValid: true };
  } catch (error: any) {
    return { isValid: false, error: error.message };
  }
}
