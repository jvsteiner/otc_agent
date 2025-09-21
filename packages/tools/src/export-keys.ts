#!/usr/bin/env node

import { UnicityKeyManager } from '@otc-broker/chains/src/utils/UnicityKeyManager';
import * as fs from 'fs';
import * as path from 'path';

interface ExportOptions {
  format: 'json' | 'wallet' | 'wif' | 'all';
  output?: string;
  seed?: string;
  addresses?: number;
}

async function exportKeys(options: ExportOptions) {
  console.log('🔑 Unicity Key Exporter for OTC Broker');
  console.log('=' .repeat(50));
  
  // Get seed from environment or options
  const seed = options.seed || process.env.HOT_WALLET_SEED || 'default-otc-broker-seed';
  
  // Initialize key manager
  const keyManager = new UnicityKeyManager(seed);
  
  // Generate addresses
  const numAddresses = options.addresses || 10;
  const walletData = keyManager.exportWalletData(numAddresses);
  
  let output = '';
  
  switch (options.format) {
    case 'json':
      // JSON format for programmatic use
      output = JSON.stringify(walletData, null, 2);
      break;
      
    case 'wallet':
      // Format compatible with HTML wallet
      output = `UNICITY OTC BROKER WALLET
Generated: ${new Date().toISOString()}
WARNING: Keep these keys secure! Anyone with these keys can access your funds.

=========================================
MASTER PRIVATE KEY (keep secret!):
${walletData.masterPrivateKey}

MASTER PRIVATE KEY IN WIF FORMAT (for importprivkey command):
${walletData.masterPrivateKeyWIF}

MASTER CHAIN CODE (for BIP32 HD wallet compatibility):
${walletData.masterChainCode}

=========================================
ESCROW ADDRESSES:

${walletData.addresses.map((addr, i) => `
Address ${i + 1}: ${addr.address}
  Private Key (hex): ${addr.privateKey}
  Private Key (WIF): ${addr.wif}
  Path: ${addr.path}
`).join('\n')}

=========================================
IMPORT INSTRUCTIONS FOR HTML WALLET:

1. Open your Unicity HTML wallet
2. Click "Restore Wallet"
3. Enter the master private key (hex format) above
4. Your addresses will be automatically derived

For individual address import in Unicity Core:
Use the WIF format private keys with the importprivkey RPC command.
`;
      break;
      
    case 'wif':
      // Just WIF keys for easy import
      output = `# WIF Private Keys for Unicity Core Import
# Usage: unicity-cli importprivkey "WIF_KEY" "label" false
# Run with false to skip rescan until all keys are imported

${walletData.addresses.map((addr, i) => 
  `importprivkey "${addr.wif}" "otc-escrow-${i}" false`
).join('\n')}

# After importing all keys, rescan the blockchain:
# unicity-cli rescanblockchain
`;
      break;
      
    case 'all':
      // Export everything in a structured format
      const allData = {
        metadata: {
          generated: new Date().toISOString(),
          version: '1.0.0',
          purpose: 'OTC Broker Escrow Keys'
        },
        master: {
          privateKey: walletData.masterPrivateKey,
          privateKeyWIF: walletData.masterPrivateKeyWIF,
          chainCode: walletData.masterChainCode
        },
        addresses: walletData.addresses.map(addr => ({
          index: addr.index,
          path: addr.path,
          address: addr.address,
          privateKey: addr.privateKey,
          privateKeyWIF: addr.wif,
          publicKey: addr.publicKey
        }))
      };
      
      output = JSON.stringify(allData, null, 2);
      break;
  }
  
  // Output to file or console
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.writeFileSync(outputPath, output);
    console.log(`✅ Keys exported to: ${outputPath}`);
    console.log(`⚠️  Remember to secure this file and delete it after importing!`);
  } else {
    console.log(output);
  }
}

// Parse command line arguments
function parseArgs(): ExportOptions {
  const args = process.argv.slice(2);
  const options: ExportOptions = {
    format: 'wallet',
    addresses: 10
  };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-f':
      case '--format':
        options.format = args[++i] as any;
        break;
      case '-o':
      case '--output':
        options.output = args[++i];
        break;
      case '-s':
      case '--seed':
        options.seed = args[++i];
        break;
      case '-n':
      case '--addresses':
        options.addresses = parseInt(args[++i]);
        break;
      case '-h':
      case '--help':
        showHelp();
        process.exit(0);
    }
  }
  
  return options;
}

function showHelp() {
  console.log(`
Unicity OTC Broker Key Export Tool

Usage: npx tsx export-keys.ts [options]

Options:
  -f, --format <type>     Output format: json, wallet, wif, all (default: wallet)
  -o, --output <file>     Output to file instead of console
  -s, --seed <seed>       Seed phrase (default: from HOT_WALLET_SEED env)
  -n, --addresses <num>   Number of addresses to generate (default: 10)
  -h, --help             Show this help message

Examples:
  # Export in wallet format to console
  npx tsx export-keys.ts

  # Export as JSON to file
  npx tsx export-keys.ts -f json -o keys.json

  # Export WIF format for import scripts
  npx tsx export-keys.ts -f wif -o import-script.sh

  # Generate 50 addresses
  npx tsx export-keys.ts -n 50 -o wallet-50.txt

Security Notes:
  - Never share your private keys
  - Delete export files after importing
  - Use encrypted storage for production
  `);
}

// Run if called directly
if (require.main === module) {
  const options = parseArgs();
  exportKeys(options).catch(console.error);
}

export { exportKeys, UnicityKeyManager };