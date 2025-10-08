/**
 * @fileoverview Generates human-readable, memorable names for deals.
 * This module creates unique deal names by combining adjectives, nouns,
 * and timestamps to improve user experience and make deals easier to identify.
 */

// Generate memorable deal names

const adjectives = [
  'swift', 'bright', 'calm', 'eager', 'fair', 'gentle', 'happy', 'jolly',
  'kind', 'lucky', 'merry', 'nice', 'proud', 'quick', 'smart', 'sunny',
  'warm', 'wise', 'brave', 'clear', 'fresh', 'golden', 'honest', 'noble',
  'silver', 'steady', 'strong', 'true', 'vivid', 'royal', 'prime', 'grand'
];

const nouns = [
  'eagle', 'falcon', 'hawk', 'tiger', 'lion', 'bear', 'wolf', 'fox',
  'deer', 'horse', 'dragon', 'phoenix', 'raven', 'dove', 'swan', 'owl',
  'shark', 'whale', 'dolphin', 'otter', 'seal', 'star', 'moon', 'sun',
  'comet', 'nova', 'ocean', 'river', 'mountain', 'valley', 'forest', 'meadow'
];

/**
 * Generates a unique, memorable name for a new deal.
 * Combines a random adjective and noun with the current date and time.
 * Format: "Adjective Noun YYYY-MM-DD HH:MM"
 *
 * @returns A unique deal name string
 *
 * @example
 * generateDealName() // "Swift Eagle 2024-01-15 14:30"
 * generateDealName() // "Golden Phoenix 2024-01-15 14:31"
 */
export function generateDealName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  
  // Get current date and time
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, ''); // HHMMSS
  
  // Create memorable name with date/time
  // Format: "Adjective Noun YYYY-MM-DD HH:MM"
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  
  return `${capitalizeFirst(adj)} ${capitalizeFirst(noun)} ${dateStr} ${hours}:${minutes}`;
}

/**
 * Capitalizes the first letter of a string.
 *
 * @param str - The string to capitalize
 * @returns String with first letter capitalized
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Validates that a deal name is safe and within acceptable bounds.
 * Prevents injection attacks and ensures reasonable length.
 *
 * @param name - The deal name to validate
 * @returns true if the name is valid, false otherwise
 *
 * @example
 * validateDealName("Swift Eagle 2024-01-15 14:30") // true
 * validateDealName("x") // false (too short)
 * validateDealName("<script>alert('xss')</script>") // false (invalid chars)
 */
export function validateDealName(name: string): boolean {
  // Must be between 3 and 100 characters
  if (name.length < 3 || name.length > 100) {
    return false;
  }
  
  // Must not contain special characters that could cause issues
  const invalidChars = /[<>\"'`]/;
  if (invalidChars.test(name)) {
    return false;
  }
  
  return true;
}