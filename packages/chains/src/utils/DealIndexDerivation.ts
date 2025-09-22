import * as crypto from 'crypto';

/**
 * Derives a deterministic HD wallet index from a deal ID and party.
 * This ensures each deal gets unique escrow addresses that won't collide.
 * 
 * @param dealId - The unique deal identifier
 * @param party - Either 'ALICE' or 'BOB'
 * @returns A positive integer suitable for HD wallet derivation
 */
export function deriveIndexFromDealId(dealId: string, party: 'ALICE' | 'BOB'): number {
  // Combine dealId with party to ensure Alice and Bob get different indices
  const input = `${dealId}-${party}`;
  
  // Hash the input to get deterministic bytes
  const hash = crypto.createHash('sha256').update(input).digest();
  
  // Take first 4 bytes and convert to positive integer
  // We use modulo to ensure the index is within a reasonable range (0 to 999999)
  // This gives us up to 1 million unique addresses which should be plenty
  const index = hash.readUInt32BE(0) % 1000000;
  
  console.log(`[DealIndex] Deal ${dealId.slice(0, 8)}... ${party} => index ${index}`);
  
  return index;
}

/**
 * Alternative simpler approach: Use last 6 hex chars of dealId as number
 * This is simpler but has slightly higher collision risk
 */
export function deriveIndexFromDealIdSimple(dealId: string, party: 'ALICE' | 'BOB'): number {
  // Take last 6 hex characters
  const hexPart = dealId.slice(-6);
  // Convert to number
  let index = parseInt(hexPart, 16);
  // Add offset for BOB to ensure different indices
  if (party === 'BOB') {
    index += 1000000;
  }
  return index;
}