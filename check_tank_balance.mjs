#!/usr/bin/env node

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

async function checkTankBalance() {
  const tankPrivateKey = process.env.TANK_WALLET_PRIVATE_KEY;
  
  if (!tankPrivateKey) {
    console.error('❌ TANK_WALLET_PRIVATE_KEY not found in .env');
    return;
  }
  
  const wallet = new ethers.Wallet(tankPrivateKey);
  console.log('🏦 Tank Wallet Address:', wallet.address);
  console.log('=====================================\n');
  
  // Check Polygon balance (for USDT operations)
  const polygonProvider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC || 'https://polygon-rpc.com');
  const polygonBalance = await polygonProvider.getBalance(wallet.address);
  console.log('Polygon Balance:', ethers.formatEther(polygonBalance), 'MATIC');
  
  if (polygonBalance === 0n) {
    console.log('  ⚠️  Tank has NO MATIC - gas funding will not work!');
    console.log('  💰 Please send at least 1 MATIC to:', wallet.address);
  } else if (parseFloat(ethers.formatEther(polygonBalance)) < 0.5) {
    console.log('  ⚠️  Low balance - recommended at least 0.5 MATIC');
  } else {
    console.log('  ✅ Sufficient MATIC for gas funding');
  }
  
  // Check Ethereum balance
  console.log('\n');
  const ethProvider = new ethers.JsonRpcProvider(process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com');
  const ethBalance = await ethProvider.getBalance(wallet.address);
  console.log('Ethereum Balance:', ethers.formatEther(ethBalance), 'ETH');
  
  if (ethBalance === 0n) {
    console.log('  ℹ️  No ETH (only needed for Ethereum operations)');
  } else {
    console.log('  ✅ Has ETH for Ethereum operations');
  }
  
  console.log('\n=====================================');
  console.log('Configuration:');
  console.log('  POLYGON_GAS_FUND_AMOUNT:', process.env.POLYGON_GAS_FUND_AMOUNT || '0.5', 'MATIC');
  console.log('  ETH_GAS_FUND_AMOUNT:', process.env.ETH_GAS_FUND_AMOUNT || '0.01', 'ETH');
}

checkTankBalance().catch(console.error);