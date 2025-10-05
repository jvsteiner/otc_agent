#!/usr/bin/env node

import { ethers } from 'ethers';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function checkTankBalance() {
  console.log('🔍 Checking Tank Wallet Balance\n');
  
  const privateKey = process.env.TANK_WALLET_PRIVATE_KEY;
  
  if (!privateKey) {
    console.error('❌ TANK_WALLET_PRIVATE_KEY not found in .env file');
    console.log('Please run: node setup_tank_wallet.mjs');
    process.exit(1);
  }
  
  // Create wallet from private key
  let wallet;
  try {
    const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    wallet = new ethers.Wallet(key);
    console.log('Tank Wallet Address:', wallet.address);
    console.log('');
  } catch (error) {
    console.error('❌ Invalid private key:', error.message);
    process.exit(1);
  }
  
  // Check balances on different chains
  const providers = {
    'Ethereum': {
      rpc: process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com',
      symbol: 'ETH',
      requiredAmount: '0.1'
    },
    'Polygon': {
      rpc: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
      symbol: 'MATIC',
      requiredAmount: '5'
    }
  };
  
  console.log('Chain Balances:');
  console.log('===============');
  
  for (const [network, config] of Object.entries(providers)) {
    try {
      const provider = new ethers.JsonRpcProvider(config.rpc);
      const balance = await provider.getBalance(wallet.address);
      const formatted = ethers.formatEther(balance);
      const required = parseFloat(config.requiredAmount);
      const hasEnough = parseFloat(formatted) >= required;
      
      console.log(`\n${network}:`);
      console.log(`  Balance: ${formatted} ${config.symbol}`);
      console.log(`  Status: ${hasEnough ? '✅ Sufficient' : '⚠️  Low balance'}`);
      console.log(`  Recommended minimum: ${config.requiredAmount} ${config.symbol}`);
      
      if (!hasEnough) {
        console.log(`  💡 Please fund the wallet with at least ${config.requiredAmount} ${config.symbol}`);
      }
    } catch (error) {
      console.log(`\n${network}: ❌ Error checking balance`);
      console.log(`  ${error.message}`);
    }
  }
  
  console.log('\n===============================');
  console.log('\nConfiguration from .env:');
  console.log(`  ETH_GAS_FUND_AMOUNT: ${process.env.ETH_GAS_FUND_AMOUNT || 'not set'} ETH`);
  console.log(`  POLYGON_GAS_FUND_AMOUNT: ${process.env.POLYGON_GAS_FUND_AMOUNT || 'not set'} MATIC`);
  console.log(`  ETH_LOW_GAS_THRESHOLD: ${process.env.ETH_LOW_GAS_THRESHOLD || 'not set'} ETH`);
  console.log(`  POLYGON_LOW_GAS_THRESHOLD: ${process.env.POLYGON_LOW_GAS_THRESHOLD || 'not set'} MATIC`);
  
  console.log('\n💡 To fund the tank wallet:');
  console.log(`  1. Send ETH to ${wallet.address} on Ethereum`);
  console.log(`  2. Send MATIC to ${wallet.address} on Polygon`);
}

checkTankBalance().catch(console.error);
