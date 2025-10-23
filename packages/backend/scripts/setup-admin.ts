#!/usr/bin/env tsx
/**
 * Simple CLI tool to set up admin credentials
 * Generates bcrypt hash and updates .env file
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Simple bcrypt implementation (pure TS, no dependencies)
async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import('bcrypt');
  return bcrypt.hash(password, 10);
}

function generateJwtSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('============================================');
  console.log('  OTC Broker - Admin Setup Tool');
  console.log('============================================\n');

  // Get admin email
  const email = await question('Admin email: ');
  if (!email || !email.includes('@')) {
    console.error('Error: Invalid email address');
    process.exit(1);
  }

  // Get password
  const password = await question('Admin password: ');
  if (!password || password.length < 8) {
    console.error('Error: Password must be at least 8 characters');
    process.exit(1);
  }

  // Confirm password
  const passwordConfirm = await question('Confirm password: ');
  if (password !== passwordConfirm) {
    console.error('Error: Passwords do not match');
    process.exit(1);
  }

  console.log('\nGenerating secure credentials...');

  // Generate password hash
  const passwordHash = await hashPassword(password);
  console.log('✓ Password hash generated');

  // Generate JWT secret
  const jwtSecret = generateJwtSecret();
  console.log('✓ JWT secret generated');

  // Update .env file
  const envPath = path.join(__dirname, '../../../.env');
  const envProdPath = path.join(__dirname, '../../../.env.production');

  const envConfig = `
# Admin Dashboard Configuration (added by setup-admin)
ADMIN_EMAIL=${email}
ADMIN_PASSWORD_HASH=${passwordHash}
ADMIN_JWT_SECRET=${jwtSecret}
ADMIN_SESSION_EXPIRY=3600
`;

  // Ask which file to update
  const target = await question('\nUpdate .env (1), .env.production (2), or both (3)? [1/2/3]: ');

  if (target === '1' || target === '3') {
    if (fs.existsSync(envPath)) {
      // Remove old admin config if exists
      let envContent = fs.readFileSync(envPath, 'utf-8');
      envContent = envContent.replace(/\n# Admin Dashboard Configuration.*?\nADMIN_SESSION_EXPIRY=\d+\n/s, '');
      fs.writeFileSync(envPath, envContent + envConfig);
      console.log(`✓ Updated ${envPath}`);
    } else {
      fs.writeFileSync(envPath, envConfig);
      console.log(`✓ Created ${envPath}`);
    }
  }

  if (target === '2' || target === '3') {
    if (fs.existsSync(envProdPath)) {
      let envContent = fs.readFileSync(envProdPath, 'utf-8');
      envContent = envContent.replace(/\n# Admin Dashboard Configuration.*?\nADMIN_SESSION_EXPIRY=\d+\n/s, '');
      fs.writeFileSync(envProdPath, envContent + envConfig);
      console.log(`✓ Updated ${envProdPath}`);
    } else {
      fs.writeFileSync(envProdPath, envConfig);
      console.log(`✓ Created ${envProdPath}`);
    }
  }

  console.log('\n============================================');
  console.log('  Admin credentials configured!');
  console.log('============================================');
  console.log(`\nEmail: ${email}`);
  console.log('\nRestart the backend to apply changes:');
  console.log('  npm run dev  (development)');
  console.log('  ./run-prod.sh  (production)');
  console.log('\nAccess admin dashboard at:');
  console.log('  http://localhost:8080/admin');
  console.log('  https://unicity-swap.dyndns.org/admin\n');

  rl.close();
}

main().catch((error) => {
  console.error('Error:', error.message);
  rl.close();
  process.exit(1);
});
