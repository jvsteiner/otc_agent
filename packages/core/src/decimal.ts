/**
 * @fileoverview Precise decimal mathematics for financial calculations.
 * This module wraps decimal.js to provide accurate arithmetic operations
 * for cryptocurrency amounts, avoiding JavaScript floating-point errors.
 * All amounts in the system must use these functions for calculations.
 */

import Decimal from 'decimal.js';

// Configure Decimal.js for financial precision
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_DOWN, // Always round down for commissions
  toExpPos: 40,
  toExpNeg: -40,
});

export { Decimal };

/**
 * Parses a string amount into a Decimal object for precise arithmetic.
 *
 * @param amount - The amount as a string (e.g., "1.5", "0.000000001")
 * @returns A Decimal object for calculations
 *
 * @example
 * const amount = parseAmount("1.5");
 * const doubled = amount.mul(2); // 3.0
 */
export function parseAmount(amount: string): Decimal {
  return new Decimal(amount);
}

/**
 * Formats a Decimal to a string with specific decimal places.
 *
 * @param decimal - The Decimal object to format
 * @param decimals - Number of decimal places to display
 * @returns Formatted string representation
 *
 * @example
 * formatAmount(new Decimal("1.23456789"), 4) // "1.2346"
 */
export function formatAmount(decimal: Decimal, decimals: number): string {
  return decimal.toFixed(decimals);
}

/**
 * Floors an amount to a specific number of decimal places.
 * Always rounds down, never up (user-favorable for commissions).
 *
 * @param amount - The amount to floor as a string
 * @param decimals - Number of decimal places to keep
 * @returns Floored amount as a string
 *
 * @example
 * floorAmount("1.23456789", 4) // "1.2345"
 * floorAmount("1.99999999", 2) // "1.99"
 */
export function floorAmount(amount: string, decimals: number): string {
  const d = parseAmount(amount);
  const factor = new Decimal(10).pow(decimals);
  return d.mul(factor).floor().div(factor).toFixed(decimals);
}

/**
 * Calculates commission based on basis points and floors to asset decimals.
 * Commission is always rounded down in favor of the user.
 *
 * @param tradeAmount - The trade amount to calculate commission from
 * @param percentBps - Commission in basis points (30 = 0.3%)
 * @param assetDecimals - Decimal places for the asset
 * @returns Commission amount as a string
 *
 * @example
 * calculateCommission("1000", 30, 6) // "3.000000" (0.3% of 1000)
 * calculateCommission("100.5", 25, 2) // "0.25" (0.25% of 100.5, floored)
 */
export function calculateCommission(
  tradeAmount: string,
  percentBps: number,
  assetDecimals: number,
): string {
  const amount = parseAmount(tradeAmount);
  const commission = amount.mul(percentBps).div(10000);
  return floorAmount(commission.toString(), assetDecimals);
}

/**
 * Sums an array of amount strings with full precision.
 *
 * @param amounts - Array of amount strings to sum
 * @returns The sum as a string
 *
 * @example
 * sumAmounts(["1.5", "2.3", "0.2"]) // "4"
 * sumAmounts(["0.000001", "0.000002"]) // "0.000003"
 */
export function sumAmounts(amounts: string[]): string {
  return amounts.reduce((sum, amount) => {
    return sum.add(parseAmount(amount));
  }, new Decimal(0)).toString();
}

/**
 * Compares two amounts and returns their relative ordering.
 *
 * @param a - First amount
 * @param b - Second amount
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 *
 * @example
 * compareAmounts("1.5", "2.0") // -1
 * compareAmounts("2.0", "2.0") // 0
 * compareAmounts("2.5", "2.0") // 1
 */
export function compareAmounts(a: string, b: string): number {
  const decA = parseAmount(a);
  const decB = parseAmount(b);
  return decA.comparedTo(decB);
}

/**
 * Checks if amount a is greater than or equal to amount b.
 *
 * @param a - First amount
 * @param b - Second amount
 * @returns true if a >= b, false otherwise
 *
 * @example
 * isAmountGte("1.5", "1.5") // true
 * isAmountGte("1.5", "2.0") // false
 */
export function isAmountGte(a: string, b: string): boolean {
  return compareAmounts(a, b) >= 0;
}

/**
 * Checks if amount a is strictly greater than amount b.
 *
 * @param a - First amount
 * @param b - Second amount
 * @returns true if a > b, false otherwise
 *
 * @example
 * isAmountGt("2.0", "1.5") // true
 * isAmountGt("1.5", "1.5") // false
 */
export function isAmountGt(a: string, b: string): boolean {
  return compareAmounts(a, b) > 0;
}

/**
 * Subtracts amount b from amount a.
 * Result can be negative (will start with '-').
 *
 * @param a - Amount to subtract from
 * @param b - Amount to subtract
 * @returns The difference as a string
 *
 * @example
 * subtractAmounts("5.0", "2.0") // "3"
 * subtractAmounts("2.0", "5.0") // "-3"
 */
export function subtractAmounts(a: string, b: string): string {
  return parseAmount(a).sub(parseAmount(b)).toString();
}