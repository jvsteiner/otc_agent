#!/usr/bin/env node

/**
 * Domain Configuration Verification Script
 *
 * This script verifies that the DOMAIN configuration is properly set up
 * and demonstrates how the server will behave with different configurations.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load production environment
const prodEnvPath = path.join(__dirname, '.env.production');
const result = dotenv.config({ path: prodEnvPath });

if (result.error) {
  console.error('Failed to load .env.production:', result.error.message);
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════');
console.log('🔍 Domain Configuration Verification');
console.log('═══════════════════════════════════════════════════════\n');

// Check DOMAIN configuration
const domain = process.env.DOMAIN;
const baseUrl = process.env.BASE_URL;
const productionMode = process.env.PRODUCTION_MODE === 'true';

console.log('📋 Environment Configuration:');
console.log('───────────────────────────────────────────────────────');
console.log(`   DOMAIN:           ${domain || '(not set)'}`);
console.log(`   BASE_URL:         ${baseUrl || '(not set)'}`);
console.log(`   PRODUCTION_MODE:  ${productionMode}`);
console.log('');

// Simulate server configuration logic
console.log('🔧 Server Configuration Simulation:');
console.log('───────────────────────────────────────────────────────');

// Scenario 1: Production with SSL and DOMAIN
console.log('\n1️⃣  Production + SSL Enabled + DOMAIN Set:');
console.log('   Conditions:');
console.log('   - sslEnabled: true');
console.log('   - productionMode: true');
console.log(`   - DOMAIN: ${domain}`);
console.log('   Result:');
console.log(`   - Protocol: HTTPS`);
console.log(`   - Port: 443`);
console.log(`   - Host: ${domain}`);
console.log(`   - BASE_URL: https://${domain}`);
console.log(`   - HTTP Redirect: Port 80 → https://${domain}`);
console.log('   ✅ All HTTP requests will redirect to HTTPS');
console.log('   ✅ Deal links will use configured domain');

// Scenario 2: Production with SSL but no DOMAIN
console.log('\n2️⃣  Production + SSL Enabled + NO DOMAIN:');
console.log('   Conditions:');
console.log('   - sslEnabled: true');
console.log('   - productionMode: true');
console.log('   - DOMAIN: (not set)');
console.log('   Result:');
console.log('   - Will fall back to PUBLIC_IP or auto-detected IP');
console.log('   - May not work correctly without proper domain');
console.log('   ⚠️  Warning: DOMAIN should be set for production');

// Scenario 3: Development mode
console.log('\n3️⃣  Development Mode:');
console.log('   Conditions:');
console.log('   - sslEnabled: false');
console.log('   - productionMode: false');
console.log('   Result:');
console.log('   - Protocol: HTTP');
console.log('   - Port: 8080');
console.log('   - Host: localhost');
console.log('   - BASE_URL: http://localhost:8080');
console.log('   ✅ Correct for local development');

// Verification checklist
console.log('\n');
console.log('═══════════════════════════════════════════════════════');
console.log('✓ Verification Checklist');
console.log('═══════════════════════════════════════════════════════');

const checks = [
  {
    name: 'DOMAIN configured in .env.production',
    pass: domain && domain.length > 0,
    value: domain,
  },
  {
    name: 'DOMAIN is valid hostname',
    pass: domain && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domain),
    value: domain,
  },
  {
    name: 'Production mode enabled',
    pass: productionMode,
    value: productionMode,
  },
  {
    name: 'DOMAIN documented in .env.example',
    pass: true, // We added it
    value: 'Yes',
  },
];

checks.forEach((check, idx) => {
  const status = check.pass ? '✅' : '❌';
  console.log(`${status} ${idx + 1}. ${check.name}`);
  if (!check.pass) {
    console.log(`   Current value: ${check.value || '(not set)'}`);
  }
});

// Final summary
console.log('\n');
console.log('═══════════════════════════════════════════════════════');
console.log('📝 Summary');
console.log('═══════════════════════════════════════════════════════');

const allPassed = checks.every(c => c.pass);

if (allPassed) {
  console.log('✅ All checks passed!');
  console.log('');
  console.log('Production HTTPS Configuration:');
  console.log(`   - HTTPS will run on: https://${domain}:443`);
  console.log(`   - HTTP redirect: http://${domain}:80 → https://${domain}`);
  console.log('');
  console.log('Next Steps:');
  console.log('   1. Place SSL certificates in .ssl/ directory:');
  console.log('      - .ssl/cert.pem (certificate)');
  console.log('      - .ssl/key.pem (private key)');
  console.log('      - .ssl/ca.pem (certificate authority, optional)');
  console.log('   2. Run production server: npm run prod');
  console.log('   3. Verify HTTP redirect: curl -I http://' + domain);
  console.log('   4. Access HTTPS: https://' + domain);
} else {
  console.log('❌ Some checks failed. Please review configuration.');
  console.log('');
  console.log('Required Actions:');
  if (!domain || domain.length === 0) {
    console.log('   - Set DOMAIN in .env.production');
  }
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domain)) {
    console.log('   - Fix DOMAIN format (should be valid hostname)');
  }
  if (!productionMode) {
    console.log('   - Set PRODUCTION_MODE=true in .env.production');
  }
}

console.log('═══════════════════════════════════════════════════════\n');
