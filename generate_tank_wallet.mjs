#!/usr/bin/env node

/**
 * Generate a new tank wallet for gas funding
 */

import { ethers } from 'ethers';
import fs from 'fs';

async function generateTankWallet() {
  console.log('🚀 Generating Tank Wallet for Gas Funding\n');
  
  // Generate new wallet
  const wallet = ethers.Wallet.createRandom();
  const privateKey = wallet.privateKey;
  
  console.log('✅ New tank wallet generated!');
  console.log('=====================================\n');
  console.log('Address:', wallet.address);
  console.log('Private Key:', privateKey);
  console.log('\n=====================================');
  
  // Check if .env exists
  const envPath = '.env';
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
    
    // Check if tank wallet is already configured
    if (envContent.includes('TANK_WALLET_PRIVATE_KEY')) {
      console.log('\n⚠️  Tank wallet already configured in .env');
      console.log('To update, manually edit .env file with the new private key above.\n');
      
      // Show existing configuration
      const existingKey = envContent.match(/TANK_WALLET_PRIVATE_KEY=(.*)/)?.[1];
      if (existingKey && existingKey !== '0x_YOUR_TANK_WALLET_PRIVATE_KEY_HERE') {
        const existingWallet = new ethers.Wallet(existingKey);
        console.log('Existing tank wallet address:', existingWallet.address);
      }
      
      return;
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
  
  console.log('\n⚠️  IMPORTANT - Next Steps:');
  console.log('=====================================');
  console.log('1. Fund the tank wallet with:');
  console.log('   - At least 0.5 MATIC on Polygon');
  console.log('   - At least 0.1 ETH on Ethereum (if using)');
  console.log('\n2. Send funds to:', wallet.address);
  console.log('\n3. Restart the backend to activate gas funding:');
  console.log('   npm run dev');
  console.log('\n=====================================');
  console.log('\nThe tank wallet will automatically fund escrows');
  console.log('when they need gas for ERC20 token transfers.');
}

generateTankWallet().catch(console.error);