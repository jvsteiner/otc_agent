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

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Validate deal name (basic validation)
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