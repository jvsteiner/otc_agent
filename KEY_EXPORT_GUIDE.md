# Unicity Key Export Guide for OTC Broker

This guide explains how to export private keys from the OTC Broker engine for use with your HTML Unicity wallet.

## Key Management Overview

The OTC Broker generates HD (Hierarchical Deterministic) wallets for managing escrow addresses on the Unicity blockchain. These keys are derived from a master seed and are compatible with your HTML wallet.

## 🎯 EASIEST METHOD: Direct HTML Wallet Export

**Generate a ready-to-use HTML wallet file with your keys already embedded:**

```bash
cd packages/tools
npx tsx src/export-html-wallet.ts -o my-wallet.html

# Then simply open my-wallet.html in your browser - that's it!
```

The HTML file:
- **Works immediately** - no import needed
- **Contains all your keys** - embedded securely
- **Auto-loads on open** - instant access
- **Fully functional** - check balances, send transactions
- **Offline capable** - no internet required after loading

### HTML Wallet Export Examples

```bash
# Basic export (10 addresses)
npx tsx src/export-html-wallet.ts -o wallet.html

# Export with 50 addresses
npx tsx src/export-html-wallet.ts -n 50 -o escrow-50.html

# Use specific seed
npx tsx src/export-html-wallet.ts -s "my-production-seed" -o prod-wallet.html

# Use existing HTML wallet as template (if you have one)
npx tsx src/export-html-wallet.ts -t /path/to/unicity-wallet.html -o custom.html
```

## Other Export Methods

### Method 1: Using the CLI Tool (for text/JSON export)

1. **Install dependencies** (if not already done):
```bash
npm install
```

2. **Export keys in wallet format**:
```bash
cd packages/tools
npx tsx src/export-keys.ts -f wallet -o my-wallet.txt
```

3. **Export options**:
- `-f wallet`: Human-readable format with instructions
- `-f json`: JSON format for programmatic use
- `-f wif`: WIF format for Unicity Core import
- `-f all`: Complete data export
- `-n 50`: Generate 50 addresses (default: 10)
- `-o file.txt`: Save to file (recommended for security)

### Method 2: Programmatic Export

```javascript
// In your code
import { UnicityPluginV2 } from '@otc-broker/chains';

// Initialize the plugin
const plugin = new UnicityPluginV2();
await plugin.init({
  chainId: 'UNICITY',
  hotWalletSeed: 'your-seed-here',
  // ... other config
});

// Export wallet data
const walletData = plugin.exportForHtmlWallet();
console.log('Master Private Key:', walletData.masterPrivateKey);
console.log('Master WIF:', walletData.masterPrivateKeyWIF);

// Export individual escrow keys
walletData.escrowAddresses.forEach(addr => {
  console.log(`Address: ${addr.address}`);
  console.log(`Private Key (hex): ${addr.privateKey}`);
  console.log(`Private Key (WIF): ${addr.privateKeyWIF}`);
});
```

### Method 3: Direct Database Query

If you need to export keys from a running system:

```bash
# Export all keys with 20 addresses
HOT_WALLET_SEED="your-production-seed" npx tsx packages/tools/src/export-keys.ts -n 20 -f all -o escrow-keys.json
```

## Import into HTML Wallet

### Option 1: Import Master Key (Recommended)

1. Open your HTML Unicity wallet
2. Click "Restore Wallet"
3. Enter the **Master Private Key** (hex format) from the export
4. The wallet will automatically derive all addresses

### Option 2: Import Individual Keys

1. For each address you want to import:
2. Use the **Private Key (WIF)** format
3. Import using the wallet's import feature

## Import into Unicity Core

Use the WIF format export:

```bash
# Generate import script
npx tsx packages/tools/src/export-keys.ts -f wif -o import.sh

# Make executable and run
chmod +x import.sh
./import.sh

# Or manually import each key
unicity-cli importprivkey "WIF_PRIVATE_KEY" "label" false

# After importing all keys, rescan
unicity-cli rescanblockchain
```

## Security Best Practices

⚠️ **CRITICAL SECURITY NOTES**:

1. **Never share private keys**: Anyone with these keys can steal funds
2. **Delete export files**: After importing, securely delete export files
3. **Use encrypted storage**: In production, always encrypt key storage
4. **Limit access**: Only export keys when absolutely necessary
5. **Use secure channels**: Never send keys over unencrypted connections

### Secure File Deletion

```bash
# On Linux/Mac
shred -vfz -n 3 my-wallet.txt

# Or use secure rm
srm -v my-wallet.txt

# Or overwrite multiple times
dd if=/dev/urandom of=my-wallet.txt bs=1024 count=$(du -k my-wallet.txt | cut -f1)
rm my-wallet.txt
```

## Environment Configuration

Set your seed in the environment for consistent key generation:

```bash
# .env file
HOT_WALLET_SEED=your-secure-seed-phrase-here

# Or export temporarily
export HOT_WALLET_SEED="your-secure-seed-phrase-here"
```

## Wallet File Format

The exported wallet file contains:

```
MASTER PRIVATE KEY: [32-byte hex]
  - Used for HD derivation
  - Import this to restore all addresses

MASTER PRIVATE KEY WIF: [Base58 encoded]
  - Same key in WIF format
  - Compatible with importprivkey RPC

ESCROW ADDRESSES:
  - Address: The Unicity address
  - Private Key (hex): Raw private key
  - Private Key (WIF): For easy import
  - Path: HD derivation path
```

## Troubleshooting

### Keys don't match expected addresses
- Ensure you're using the same seed
- Check the derivation path
- Verify you're on the correct network (mainnet vs testnet)

### Can't import into HTML wallet
- Ensure private key is in hex format (64 characters)
- Try WIF format if hex doesn't work
- Check for extra spaces or characters

### Transaction signing fails
- Verify the private key matches the address
- Ensure sufficient balance for fees
- Check UTXO availability

## Recovery Scenarios

### Recover from seed only
```bash
# Regenerate all keys from seed
HOT_WALLET_SEED="original-seed" npx tsx packages/tools/src/export-keys.ts -n 100
```

### Find which index was used
Check the database or logs for the highest key index used, then generate enough keys to cover all addresses.

## Integration with OTC Broker

The OTC Broker automatically:
1. Generates new escrow addresses as needed
2. Stores key references in the database
3. Signs transactions using stored keys
4. Never exposes private keys in logs or API responses

## Additional Tools

### Check Address Balance
```bash
# Use the wallet to check balance
# Or use Electrum API directly
```

### Generate Specific Address
```javascript
const keyManager = new UnicityKeyManager(seed);
const key = keyManager.deriveKey(42); // Get key at index 42
console.log(key.address, key.wif);
```

## Support

For issues or questions:
- Check the main README.md
- Review the test files for examples
- Open an issue on GitHub

Remember: **Your keys, your coins. Not your keys, not your coins.**