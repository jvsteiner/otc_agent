import Decimal from 'decimal.js';

// Configure Decimal.js for financial precision
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_DOWN, // Always round down for commissions
  toExpPos: 40,
  toExpNeg: -40,
});

export { Decimal };

export function parseAmount(amount: string): Decimal {
  return new Decimal(amount);
}

export function formatAmount(decimal: Decimal, decimals: number): string {
  return decimal.toFixed(decimals);
}

export function floorAmount(amount: string, decimals: number): string {
  const d = parseAmount(amount);
  const factor = new Decimal(10).pow(decimals);
  return d.mul(factor).floor().div(factor).toFixed(decimals);
}

export function calculateCommission(
  tradeAmount: string,
  percentBps: number,
  assetDecimals: number,
): string {
  const amount = parseAmount(tradeAmount);
  const commission = amount.mul(percentBps).div(10000);
  return floorAmount(commission.toString(), assetDecimals);
}

export function sumAmounts(amounts: string[]): string {
  return amounts.reduce((sum, amount) => {
    return sum.add(parseAmount(amount));
  }, new Decimal(0)).toString();
}

export function compareAmounts(a: string, b: string): number {
  const decA = parseAmount(a);
  const decB = parseAmount(b);
  return decA.comparedTo(decB);
}

export function isAmountGte(a: string, b: string): boolean {
  return compareAmounts(a, b) >= 0;
}

export function isAmountGt(a: string, b: string): boolean {
  return compareAmounts(a, b) > 0;
}

export function subtractAmounts(a: string, b: string): string {
  return parseAmount(a).sub(parseAmount(b)).toString();
}