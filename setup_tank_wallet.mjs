#!/usr/bin/env node

/**
 * Setup script for Tank Wallet
 * This script helps you configure the gas funding tank wallet
 */

import { ethers } from 'ethers';
import fs from 'fs';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function setupTankWallet() {
  console.log('🚀 Tank Wallet Setup Script\n');
  console.log('This will help you configure a tank wallet for gas funding.\n');
  
  const choice = await question('Choose an option:\n1. Generate new tank wallet\n2. Use existing private key\n\nEnter choice (1 or 2): ');
  
  let privateKey;
  let wallet;
  
  if (choice === '1') {
    // Generate new wallet
    wallet = ethers.Wallet.createRandom();
    privateKey = wallet.privateKey;
    
    console.log('\n✅ New tank wallet generated!');
    console.log('Address:', wallet.address);
    console.log('Private Key:', privateKey);
    console.log('\n⚠️  IMPORTANT: Save this private key securely! You will need to fund this wallet with:');
    console.log('   - ETH for Ethereum operations (recommended: 0.5 ETH)');
    console.log('   - MATIC for Polygon operations (recommended: 50 MATIC)\n');
  } else if (choice === '2') {
    const key = await question('\nEnter private key (with or without 0x prefix): ');
    
    try {
      // Add 0x prefix if not present
      privateKey = key.startsWith('0x') ? key : `0x${key}`;
      wallet = new ethers.Wallet(privateKey);
      
      console.log('\n✅ Wallet loaded successfully!');
      console.log('Address:', wallet.address);
    } catch (error) {
      console.error('❌ Invalid private key:', error.message);
      rl.close();
      process.exit(1);
    }
  } else {
    console.log('Invalid choice');
    rl.close();
    process.exit(1);
  }
  
  // Check if .env exists
  const envPath = '.env';
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
    
    // Check if tank wallet is already configured
    if (envContent.includes('TANK_WALLET_PRIVATE_KEY')) {
      const overwrite = await question('\n⚠️  Tank wallet already configured in .env. Overwrite? (y/n): ');
      if (overwrite.toLowerCase() !== 'y') {
        console.log('Setup cancelled');
        rl.close();
        process.exit(0);
      }
      
      // Remove existing tank configuration
      envContent = envContent.split('\n')
        .filter(line => !line.startsWith('TANK_WALLET_PRIVATE_KEY') && 
                       !line.startsWith('ETH_GAS_FUND_AMOUNT') &&
                       !line.startsWith('POLYGON_GAS_FUND_AMOUNT') &&
                       !line.startsWith('ETH_LOW_GAS_THRESHOLD') &&
                       !line.startsWith('POLYGON_LOW_GAS_THRESHOLD'))
        .join('\n');
    }
  }
  
  // Add tank configuration
  const tankConfig = `
# Tank Wallet Configuration (for gas funding)
TANK_WALLET_PRIVATE_KEY=${privateKey}
ETH_GAS_FUND_AMOUNT=0.01        # ETH to send for gas funding
POLYGON_GAS_FUND_AMOUNT=0.5     # MATIC to send for gas funding
ETH_LOW_GAS_THRESHOLD=0.1       # Alert when tank ETH balance is below this
POLYGON_LOW_GAS_THRESHOLD=5     # Alert when tank MATIC balance is below this
`;
  
  // Write to .env
  fs.writeFileSync(envPath, envContent + tankConfig);
  
  console.log('\n✅ Tank wallet configuration added to .env');
  
  // Check balances
  console.log('\n📊 Checking tank wallet balances...\n');
  
  const providers = {
    Ethereum: new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com'),
    Polygon: new ethers.JsonRpcProvider('https://polygon-rpc.com')
  };
  
  for (const [network, provider] of Object.entries(providers)) {
    try {
      const balance = await provider.getBalance(wallet.address);
      const formatted = ethers.formatEther(balance);
      const symbol = network === 'Ethereum' ? 'ETH' : 'MATIC';
      
      console.log(`${network}: ${formatted} ${symbol}`);
      
      if (balance === 0n) {
        console.log(`  ⚠️  Please fund the tank wallet on ${network}`);
      }
    } catch (error) {
      console.log(`${network}: Error checking balance`);
    }
  }
  
  console.log('\n📋 Next Steps:');
  console.log('1. Fund the tank wallet with ETH and MATIC');
  console.log('2. Restart the OTC backend to activate gas funding');
  console.log('3. The system will automatically fund escrows when needed');
  
  console.log('\n💡 Tank Wallet Address for funding:', wallet.address);
  console.log('\nYou can send funds to this address on:');
  console.log('  - Ethereum network for ETH');
  console.log('  - Polygon network for MATIC');
  
  rl.close();
}

setupTankWallet().catch(console.error);