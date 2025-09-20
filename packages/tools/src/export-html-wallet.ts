#!/usr/bin/env node

import { UnicityKeyManager } from '@otc-broker/chains/src/utils/UnicityKeyManager';
import * as fs from 'fs';
import * as path from 'path';

interface HtmlWalletOptions {
  seed?: string;
  output?: string;
  addresses?: number;
  templatePath?: string;
  encrypted?: boolean;
  password?: string;
}

async function exportHtmlWallet(options: HtmlWalletOptions) {
  console.log('🌐 Generating HTML Wallet with Embedded Keys');
  console.log('=' .repeat(50));
  
  // Get seed from environment or options
  const seed = options.seed || process.env.HOT_WALLET_SEED || 'default-otc-broker-seed';
  
  // Initialize key manager
  const keyManager = new UnicityKeyManager(seed);
  
  // Generate addresses
  const numAddresses = options.addresses || 10;
  const walletData = keyManager.exportWalletData(numAddresses);
  
  // Read template or use the reference wallet
  let htmlTemplate: string;
  if (options.templatePath) {
    htmlTemplate = fs.readFileSync(options.templatePath, 'utf-8');
  } else {
    // Read from the reference HTML wallet if available
    const refWalletPath = path.join(__dirname, '../../../ref_materials/guiwallet/index.html');
    if (fs.existsSync(refWalletPath)) {
      htmlTemplate = fs.readFileSync(refWalletPath, 'utf-8');
    } else {
      // Use embedded minimal template
      htmlTemplate = getMinimalWalletTemplate();
    }
  }
  
  // Prepare wallet data for injection
  const walletObject = {
    masterPrivateKey: walletData.masterPrivateKey,
    masterChainCode: walletData.masterChainCode,
    isImportedAlphaWallet: true,
    addresses: walletData.addresses.map((addr, index) => ({
      index,
      address: addr.address,
      path: addr.path,
      privateKey: addr.privateKey
    })),
    isEncrypted: false,
    encryptedMasterKey: ''
  };
  
  // Create initialization script
  const initScript = `
<script>
// Auto-initialize wallet with embedded keys from OTC Broker
(function() {
  // Wait for DOM and dependencies to load
  function initializeEmbeddedWallet() {
    if (typeof window.walletGlobal === 'undefined') {
      window.walletGlobal = {};
    }
    
    // Embedded wallet data from OTC Broker
    const embeddedWallet = ${JSON.stringify(walletObject, null, 2)};
    
    // Set wallet data
    window.walletGlobal = embeddedWallet;
    
    // Store in localStorage with unique key
    const storageKey = 'wallet_otc_' + embeddedWallet.masterPrivateKey.substring(0, 8);
    localStorage.setItem(storageKey, JSON.stringify(embeddedWallet));
    localStorage.setItem('currentWalletKey', storageKey);
    localStorage.setItem('alphaWallet', JSON.stringify(embeddedWallet)); // Legacy support
    
    // Initialize UI if available
    if (typeof window.initializeFromEmbeddedWallet === 'function') {
      window.initializeFromEmbeddedWallet(embeddedWallet);
    } else if (typeof window.updateUIFromWallet === 'function') {
      // For existing wallet interface
      Object.assign(window.wallet || {}, embeddedWallet);
      window.updateUIFromWallet();
    }
    
    // Show notification
    if (typeof window.showInAppNotification === 'function') {
      window.showInAppNotification(
        'Wallet Loaded', 
        'OTC Broker escrow wallet loaded with ' + embeddedWallet.addresses.length + ' addresses',
        'success'
      );
    } else {
      console.log('✅ OTC Broker wallet loaded with', embeddedWallet.addresses.length, 'addresses');
    }
  }
  
  // Try to initialize immediately or wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(initializeEmbeddedWallet, 100);
    });
  } else {
    setTimeout(initializeEmbeddedWallet, 100);
  }
})();
</script>
`;
  
  // Inject the initialization script
  let finalHtml: string;
  
  if (htmlTemplate.includes('</body>')) {
    // Inject before closing body tag
    finalHtml = htmlTemplate.replace('</body>', initScript + '\n</body>');
  } else if (htmlTemplate.includes('</html>')) {
    // Inject before closing html tag
    finalHtml = htmlTemplate.replace('</html>', initScript + '\n</html>');
  } else {
    // Append at the end
    finalHtml = htmlTemplate + initScript;
  }
  
  // Add title modification to indicate it's an OTC Broker wallet
  finalHtml = finalHtml.replace(
    /<title>[^<]*<\/title>/,
    '<title>OTC Broker Escrow Wallet - ' + walletData.addresses[0].address.substring(0, 8) + '...</title>'
  );
  
  // Add a banner to indicate this is an OTC Broker wallet
  const bannerHtml = `
<div id="otc-broker-banner" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 10px; text-align: center; font-family: monospace; position: fixed; top: 0; left: 0; right: 0; z-index: 10000; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">
  🔐 OTC Broker Escrow Wallet | ${numAddresses} Addresses | Seed: ${seed.substring(0, 8)}...
  <button onclick="document.getElementById('otc-broker-banner').style.display='none'" style="float: right; background: rgba(255,255,255,0.2); border: none; color: white; padding: 2px 8px; cursor: pointer; border-radius: 3px;">✕</button>
</div>
<style>
  body { padding-top: 50px !important; }
</style>
`;
  
  if (finalHtml.includes('<body>')) {
    finalHtml = finalHtml.replace('<body>', '<body>' + bannerHtml);
  } else if (finalHtml.includes('<body ')) {
    finalHtml = finalHtml.replace(/<body([^>]*)>/, '<body$1>' + bannerHtml);
  }
  
  // Output to file
  const outputPath = options.output || `otc-wallet-${Date.now()}.html`;
  const fullPath = path.resolve(outputPath);
  fs.writeFileSync(fullPath, finalHtml);
  
  console.log(`✅ HTML wallet generated: ${fullPath}`);
  console.log(`📋 Wallet contains:`);
  console.log(`   - Master Private Key: ${walletData.masterPrivateKey.substring(0, 8)}...`);
  console.log(`   - First Address: ${walletData.addresses[0].address}`);
  console.log(`   - Total Addresses: ${numAddresses}`);
  console.log(`\n📖 Usage:`);
  console.log(`   1. Open ${path.basename(fullPath)} in your browser`);
  console.log(`   2. The wallet will auto-load with your keys`);
  console.log(`   3. You can immediately check balances and send transactions`);
  console.log(`\n⚠️  Security:`);
  console.log(`   - This file contains private keys!`);
  console.log(`   - Store it securely or delete after use`);
  console.log(`   - Never share or upload this file`);
}

function getMinimalWalletTemplate(): string {
  // Minimal self-contained wallet template
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OTC Broker Escrow Wallet</title>
    <style>
        body {
            font-family: monospace;
            max-width: 800px;
            margin: 50px auto;
            padding: 20px;
            background: #f0f0f0;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #667eea;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }
        .address-list {
            margin: 20px 0;
        }
        .address-item {
            background: #f8f8f8;
            padding: 15px;
            margin: 10px 0;
            border-radius: 5px;
            font-size: 12px;
            word-break: break-all;
        }
        .key-display {
            background: #fffacd;
            padding: 10px;
            border-left: 4px solid #ffd700;
            margin: 10px 0;
        }
        button {
            background: #667eea;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            margin: 5px;
        }
        button:hover {
            background: #764ba2;
        }
        .warning {
            background: #ffebee;
            border-left: 4px solid #f44336;
            padding: 10px;
            margin: 20px 0;
            color: #c62828;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 OTC Broker Escrow Wallet</h1>
        
        <div class="warning">
            ⚠️ This wallet contains private keys! Keep this file secure and never share it.
        </div>
        
        <div id="wallet-info">
            <h2>Wallet Status</h2>
            <p>Loading wallet data...</p>
        </div>
        
        <div id="master-key" class="key-display" style="display:none;">
            <strong>Master Private Key:</strong>
            <div id="master-key-value" style="font-family: monospace; margin-top: 10px;"></div>
        </div>
        
        <div id="addresses" class="address-list">
            <h2>Escrow Addresses</h2>
            <div id="address-container"></div>
        </div>
        
        <div style="margin-top: 30px;">
            <button onclick="toggleMasterKey()">Show/Hide Master Key</button>
            <button onclick="exportAddresses()">Export Address List</button>
            <button onclick="copyAllAddresses()">Copy All Addresses</button>
        </div>
    </div>
    
    <script>
        let walletData = null;
        
        window.initializeFromEmbeddedWallet = function(embedded) {
            walletData = embedded;
            updateDisplay();
        };
        
        function updateDisplay() {
            if (!walletData) return;
            
            // Update wallet info
            document.getElementById('wallet-info').innerHTML = \`
                <h2>Wallet Status</h2>
                <p>✅ Wallet loaded successfully</p>
                <p>📍 Addresses: \${walletData.addresses.length}</p>
                <p>🔑 Type: \${walletData.isImportedAlphaWallet ? 'HD Wallet' : 'Standard'}</p>
            \`;
            
            // Update master key
            document.getElementById('master-key-value').textContent = walletData.masterPrivateKey;
            
            // Update addresses
            const container = document.getElementById('address-container');
            container.innerHTML = walletData.addresses.map((addr, i) => \`
                <div class="address-item">
                    <strong>Address #\${i + 1}:</strong> \${addr.address}<br>
                    <small>Path: \${addr.path || 'm/44\\'/0\\'/0/' + i}</small><br>
                    <button onclick="copyText('\${addr.address}')" style="margin-top: 5px; padding: 5px 10px; font-size: 11px;">Copy</button>
                    <button onclick="showPrivateKey(\${i})" style="margin-top: 5px; padding: 5px 10px; font-size: 11px;">Show Key</button>
                </div>
            \`).join('');
        }
        
        function toggleMasterKey() {
            const keyDiv = document.getElementById('master-key');
            keyDiv.style.display = keyDiv.style.display === 'none' ? 'block' : 'none';
        }
        
        function copyText(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('Copied to clipboard!');
            });
        }
        
        function copyAllAddresses() {
            const addresses = walletData.addresses.map(a => a.address).join('\\n');
            copyText(addresses);
        }
        
        function exportAddresses() {
            const data = walletData.addresses.map(a => 
                \`\${a.address},\${a.path || 'm/44\\'/0\\'/0/' + a.index}\`
            ).join('\\n');
            
            const blob = new Blob([data], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'otc-escrow-addresses.csv';
            a.click();
        }
        
        function showPrivateKey(index) {
            const addr = walletData.addresses[index];
            if (addr.privateKey) {
                if (confirm('Show private key for ' + addr.address + '?')) {
                    alert('Private Key (hex):\\n' + addr.privateKey);
                }
            }
        }
        
        // Initialize on load
        window.walletGlobal = window.walletGlobal || {};
    </script>
</body>
</html>`;
}

// Parse command line arguments
function parseArgs(): HtmlWalletOptions {
  const args = process.argv.slice(2);
  const options: HtmlWalletOptions = {
    addresses: 10
  };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
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
      case '-t':
      case '--template':
        options.templatePath = args[++i];
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
OTC Broker HTML Wallet Generator

Creates a standalone HTML wallet file with embedded keys that can be directly
opened in a browser - no import needed!

Usage: npx tsx export-html-wallet.ts [options]

Options:
  -o, --output <file>      Output HTML file (default: otc-wallet-{timestamp}.html)
  -s, --seed <seed>        Seed phrase (default: from HOT_WALLET_SEED env)
  -n, --addresses <num>    Number of addresses to generate (default: 10)
  -t, --template <path>    Path to HTML wallet template (optional)
  -h, --help              Show this help message

Examples:
  # Generate wallet with 10 addresses
  npx tsx export-html-wallet.ts -o my-wallet.html

  # Generate with 50 addresses
  npx tsx export-html-wallet.ts -n 50 -o escrow-wallet.html

  # Use specific seed
  npx tsx export-html-wallet.ts -s "my-secret-seed" -o wallet.html

  # Use the actual Unicity HTML wallet as template
  npx tsx export-html-wallet.ts -t ../../../ref_materials/guiwallet/index.html

Output:
  The generated HTML file:
  - Contains all private keys embedded
  - Auto-loads when opened in browser
  - Works completely offline
  - No import/restore needed
  - Compatible with Unicity network

Security:
  ⚠️  The HTML file contains private keys!
  - Store it securely (encrypted USB, secure folder)
  - Never upload to cloud services
  - Delete after transferring funds
  - Use only on trusted computers
`);
}

// Run if called directly
if (require.main === module) {
  const options = parseArgs();
  exportHtmlWallet(options).catch(console.error);
}

export { exportHtmlWallet };