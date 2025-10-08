# Tools Module Documentation

## Executive Summary

The `@otc-broker/tools` module provides essential command-line utilities and scripts for managing OTC broker operations, specifically focused on Unicity blockchain wallet management and key derivation. This module serves as the operational toolkit for system administrators and developers, enabling secure generation, export, and management of HD (Hierarchical Deterministic) wallet addresses used in escrow operations.

## Module Overview

### Purpose

The Tools module addresses critical operational requirements in the OTC broker system:
- **Key Management**: Secure generation and export of deterministic wallet addresses
- **Wallet Portability**: Creation of standalone HTML wallets for offline operations
- **Operational Scripts**: Command-line tools for system administration
- **Development Utilities**: Scripts for testing and development workflows

### Architecture Position

```
OTC Broker System
│
├── packages/core          (Core types and logic)
├── packages/chains        (Blockchain adapters)
├── packages/backend       (Server and engine)
├── packages/web          (User interface)
└── packages/tools        (THIS MODULE - CLI utilities)
    ├── src/
    │   ├── export-keys.ts      (Key export utility)
    │   └── export-html-wallet.ts (HTML wallet generator)
    └── dist/                   (Compiled JavaScript)
```

## Core Components

### 1. Key Export Utility (`export-keys.ts`)

#### Purpose
Exports Unicity wallet keys in multiple formats for various operational scenarios. This tool is essential for:
- Backing up escrow wallet keys
- Importing keys into different wallet software
- Generating deterministic addresses for testing
- Creating audit trails of wallet addresses

#### Technical Design

**Key Derivation Architecture:**
- Uses BIP32/BIP44 hierarchical deterministic (HD) key derivation
- Derives from a master seed phrase (HOT_WALLET_SEED)
- Generates child keys using hardened derivation paths
- Maintains compatibility with Unicity's UTXO model

**Export Formats:**

1. **JSON Format** (`--format json`)
   - Structured data for programmatic consumption
   - Contains full key hierarchy with metadata
   - Suitable for backup and restoration

2. **Wallet Format** (`--format wallet`)
   - Human-readable format with instructions
   - Includes master keys and derived addresses
   - Compatible with HTML wallet import

3. **WIF Format** (`--format wif`)
   - Wallet Import Format for Unicity Core
   - Script-ready commands for batch import
   - Optimized for command-line operations

4. **All Format** (`--format all`)
   - Comprehensive export with all key data
   - Includes metadata and timestamps
   - Full audit trail capability

#### Usage Examples

**Basic Export:**
```bash
# Export with default settings (10 addresses, wallet format)
npm run export-keys

# Export to file
npm run export-keys -- --output keys.txt
```

**Advanced Usage:**
```bash
# Export 50 addresses as JSON
npx tsx src/export-keys.ts --format json --addresses 50 --output escrow-keys.json

# Generate WIF import script
npx tsx src/export-keys.ts --format wif --output import-script.sh

# Use custom seed
npx tsx src/export-keys.ts --seed "custom seed phrase" --addresses 20
```

**Import into Unicity Core:**
```bash
# Using generated WIF script
chmod +x import-script.sh
./import-script.sh

# Manual import
unicity-cli importprivkey "WIF_KEY" "label" false
unicity-cli rescanblockchain
```

#### Security Considerations

- **Seed Protection**: Never expose HOT_WALLET_SEED in logs or commits
- **File Permissions**: Exported files should have restricted permissions (600)
- **Secure Deletion**: Use secure deletion methods for key files
- **Air-Gap Operations**: Consider offline key generation for production

### 2. HTML Wallet Generator (`export-html-wallet.ts`)

#### Purpose
Creates self-contained HTML wallet files with embedded private keys, enabling:
- Offline wallet operations
- Emergency access without infrastructure
- Browser-based transaction signing
- Distribution of pre-configured wallets

#### Technical Design

**Wallet Embedding Architecture:**
```javascript
// Embedded wallet structure
{
  masterPrivateKey: "hex_string",
  masterChainCode: "hex_string",
  isImportedAlphaWallet: true,
  addresses: [
    {
      index: 0,
      address: "unicity_address",
      path: "m/44'/0'/0'/0",
      privateKey: "hex_string"
    }
  ]
}
```

**Template System:**
1. **Reference Template**: Uses actual Unicity GUI wallet if available
2. **Minimal Template**: Fallback self-contained HTML/CSS/JS
3. **Custom Template**: Support for user-provided templates

**Auto-Initialization Flow:**
```
HTML Load → DOM Ready → Inject Wallet Data →
Initialize UI → Store in LocalStorage → Ready
```

#### Usage Examples

**Basic Generation:**
```bash
# Generate HTML wallet with 10 addresses
npm run export-html

# Generate with custom output
npm run export-html -- --output my-wallet.html
```

**Advanced Usage:**
```bash
# Generate 50-address wallet
npx tsx src/export-html-wallet.ts --addresses 50 --output escrow-wallet.html

# Use custom seed
npx tsx src/export-html-wallet.ts --seed "production seed" --output prod-wallet.html

# Use reference wallet template
npx tsx src/export-html-wallet.ts \
  --template ../../../ref_materials/guiwallet/index.html \
  --output enhanced-wallet.html
```

#### Generated Wallet Features

**User Interface:**
- Visual wallet status display
- Address list with copy functionality
- Private key reveal (with confirmation)
- Master key show/hide toggle
- Export capabilities (CSV format)

**Security Features:**
- Warning banners for key exposure
- Confirmation dialogs for sensitive operations
- Local-only storage (no network calls)
- Offline transaction capability

#### Browser Compatibility
- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Full support (with clipboard API limitations)
- Mobile browsers: Limited support (view-only recommended)

## Implementation Details

### Dependency Management

**Internal Dependencies:**
```typescript
import { UnicityKeyManager } from '@otc-broker/chains/src/utils/UnicityKeyManager';
// Provides HD key derivation and address generation
```

**External Dependencies:**
- `fs`: File system operations
- `path`: Path manipulation
- `node:crypto`: Cryptographic operations (via UnicityKeyManager)

### Key Generation Algorithm

**BIP32 Derivation Path:**
```
m/44'/0'/0'/index
│  │  │  │    └── Address index (0-n)
│  │  │  └────── External chain (always 0)
│  │  └────────── Account (always 0 for OTC)
│  └───────────── Coin type (0 for Unicity)
└──────────────── Purpose (44 for BIP44)
```

**Address Generation Process:**
1. Master seed → Master private key + chain code
2. Derive child key at path m/44'/0'/0'
3. For each address index:
   - Derive child key at index
   - Generate public key
   - Create Unicity address
   - Export in requested format

### Error Handling

**Common Error Scenarios:**
```typescript
// File write errors
try {
  fs.writeFileSync(outputPath, content);
} catch (error) {
  console.error(`Failed to write to ${outputPath}: ${error.message}`);
  process.exit(1);
}

// Invalid seed handling
if (!seed || seed.length < 12) {
  console.error('Invalid seed phrase');
  process.exit(1);
}

// Path resolution errors
const fullPath = path.resolve(outputPath);
if (!fs.existsSync(path.dirname(fullPath))) {
  console.error('Output directory does not exist');
  process.exit(1);
}
```

## Configuration

### Environment Variables

**Required:**
```bash
HOT_WALLET_SEED=<seed-phrase>  # Master seed for HD wallet derivation
```

**Optional:**
```bash
NODE_ENV=production            # Enable production safeguards
DEBUG=otc:tools:*              # Enable debug logging
```

### Package Scripts

```json
{
  "scripts": {
    "build": "tsc",                    // Compile TypeScript
    "clean": "rm -rf dist",            // Clean build artifacts
    "export-keys": "tsx src/export-keys.ts",     // Run key exporter
    "export-html": "tsx src/export-html-wallet.ts", // Generate HTML wallet
    "test": "vitest"                   // Run tests
  }
}
```

## Security Model

### Threat Model

**Key Exposure Risks:**
1. **File System**: Exported keys on disk
2. **Memory**: Keys in process memory
3. **Logs**: Accidental key logging
4. **Network**: No network operations (air-gapped)

### Mitigation Strategies

**Operational Security:**
```bash
# Secure key export workflow
export HOT_WALLET_SEED="..." # Set in secure environment
npm run export-keys -- --output /tmp/keys.json
# Process keys
shred -vfz /tmp/keys.json    # Secure deletion
```

**Code-Level Protections:**
- No network imports or dependencies
- No telemetry or analytics
- Explicit user confirmation for sensitive operations
- Clear security warnings in output

### Best Practices

1. **Production Operations:**
   - Use hardware security modules (HSM) when available
   - Implement key rotation policies
   - Maintain audit logs of key operations
   - Use multi-signature schemes for critical operations

2. **Development Workflow:**
   - Use separate seeds for dev/staging/production
   - Never commit keys or seeds to version control
   - Implement pre-commit hooks to detect keys
   - Use environment-specific key derivation paths

## Testing

### Unit Tests

**Key Derivation Tests:**
```typescript
describe('UnicityKeyManager', () => {
  it('should generate deterministic addresses', () => {
    const seed = 'test seed phrase';
    const manager = new UnicityKeyManager(seed);
    const addresses = manager.exportWalletData(5);

    // Addresses should be deterministic
    expect(addresses.addresses[0].address).toBe('expected_address');
  });
});
```

**Export Format Tests:**
```typescript
describe('Export Formats', () => {
  it('should export valid JSON', () => {
    const output = exportKeys({ format: 'json' });
    const parsed = JSON.parse(output);
    expect(parsed.addresses).toHaveLength(10);
  });

  it('should generate valid WIF keys', () => {
    const output = exportKeys({ format: 'wif' });
    expect(output).toContain('importprivkey');
  });
});
```

### Integration Tests

**End-to-End Workflow:**
```bash
# Test key generation and import
npm run export-keys -- --format wif --output test.sh
bash test.sh  # Import into test Unicity node
# Verify addresses are accessible
```

## Troubleshooting

### Common Issues

**Issue: "Cannot find module '@otc-broker/chains'"**
```bash
# Solution: Build dependencies first
cd ../.. && npm run build
```

**Issue: "Invalid seed phrase"**
```bash
# Check environment variable
echo $HOT_WALLET_SEED
# Ensure seed has sufficient entropy (12+ words)
```

**Issue: "HTML wallet doesn't load"**
```javascript
// Check browser console for errors
// Verify localStorage is available
// Ensure JavaScript is enabled
```

### Debug Mode

**Enable Verbose Logging:**
```typescript
// Add to export-keys.ts
const DEBUG = process.env.DEBUG === 'true';
if (DEBUG) {
  console.log('Seed:', seed.substring(0, 8) + '...');
  console.log('Derivation path:', path);
}
```

## Performance Characteristics

### Benchmarks

**Key Generation Performance:**
- 10 addresses: ~50ms
- 100 addresses: ~500ms
- 1000 addresses: ~5 seconds

**HTML Generation:**
- Template parsing: ~10ms
- Data injection: ~5ms
- File write: ~20ms

### Optimization Opportunities

1. **Parallel Derivation**: Use worker threads for large address counts
2. **Caching**: Implement derived key caching for repeated operations
3. **Lazy Loading**: Generate addresses on-demand for HTML wallet

## Future Enhancements

### Planned Features

1. **Multi-Chain Support**
   - Ethereum address derivation
   - Bitcoin address formats
   - Solana wallet generation

2. **Enhanced Security**
   - Hardware wallet integration
   - Encrypted export formats
   - Multi-signature wallet support

3. **Operational Tools**
   - Automated backup scripts
   - Key rotation utilities
   - Audit log generators

4. **Developer Tools**
   - Test wallet generators
   - Faucet integration
   - Transaction simulators

### Architecture Evolution

```
Current: Simple CLI tools
    ↓
Phase 2: Service-oriented tools with API
    ↓
Phase 3: Distributed key management system
```

## API Reference

### exportKeys Function

```typescript
async function exportKeys(options: ExportOptions): Promise<void>
```

**Parameters:**
- `options.format`: Output format ('json' | 'wallet' | 'wif' | 'all')
- `options.output`: Output file path (optional)
- `options.seed`: Seed phrase (optional, defaults to env)
- `options.addresses`: Number of addresses (default: 10)

### exportHtmlWallet Function

```typescript
async function exportHtmlWallet(options: HtmlWalletOptions): Promise<void>
```

**Parameters:**
- `options.seed`: Seed phrase (optional)
- `options.output`: Output HTML file path
- `options.addresses`: Number of addresses (default: 10)
- `options.templatePath`: Custom template path (optional)

## Appendices

### A. Command Reference

```bash
# Key Export Commands
npm run export-keys                           # Default export
npm run export-keys -- --format json          # JSON format
npm run export-keys -- --format wif           # WIF format
npm run export-keys -- --format all           # All data
npm run export-keys -- --addresses 50         # 50 addresses
npm run export-keys -- --output file.txt      # To file

# HTML Wallet Commands
npm run export-html                           # Default HTML
npm run export-html -- --output wallet.html   # Named file
npm run export-html -- --addresses 100        # 100 addresses
npm run export-html -- --template custom.html # Custom template
```

### B. File Formats

**JSON Export Schema:**
```json
{
  "metadata": {
    "generated": "ISO-8601 timestamp",
    "version": "1.0.0",
    "purpose": "OTC Broker Escrow Keys"
  },
  "master": {
    "privateKey": "hex",
    "privateKeyWIF": "base58",
    "chainCode": "hex"
  },
  "addresses": [
    {
      "index": 0,
      "path": "m/44'/0'/0'/0",
      "address": "unicity_address",
      "privateKey": "hex",
      "privateKeyWIF": "base58",
      "publicKey": "hex"
    }
  ]
}
```

### C. Security Checklist

- [ ] Environment variables secured
- [ ] File permissions restricted (600)
- [ ] No keys in version control
- [ ] Secure deletion after use
- [ ] Audit logs maintained
- [ ] Regular key rotation
- [ ] Backup procedures tested
- [ ] Recovery procedures documented

## Conclusion

The Tools module provides critical infrastructure for OTC broker operations, focusing on secure and efficient wallet management. Its design prioritizes security, usability, and operational flexibility, making it an essential component of the overall system architecture. The module's self-contained nature and comprehensive documentation ensure that it can be effectively utilized in various deployment scenarios, from development to production operations.