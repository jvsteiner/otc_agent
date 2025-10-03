#!/usr/bin/env node

/**
 * Test script for gas funding functionality
 * This script demonstrates how the tank wallet funds escrow addresses with gas
 * before executing ERC20 token transfers.
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

async function testGasFunding() {
  console.log('🚀 Gas Funding Test Script\n');
  
  // Check if tank wallet is configured
  const tankPrivateKey = process.env.TANK_WALLET_PRIVATE_KEY;
  if (!tankPrivateKey) {
    console.error('❌ TANK_WALLET_PRIVATE_KEY not configured in .env');
    console.log('Please add: TANK_WALLET_PRIVATE_KEY=0x... to your .env file');
    process.exit(1);
  }
  
  // Setup provider
  const rpcUrl = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  // Create tank wallet
  const tankWallet = new ethers.Wallet(tankPrivateKey, provider);
  console.log('Tank Wallet Address:', tankWallet.address);
  
  // Check tank balance
  const tankBalance = await provider.getBalance(tankWallet.address);
  console.log('Tank Balance:', ethers.formatEther(tankBalance), 'MATIC\n');
  
  if (tankBalance === 0n) {
    console.error('❌ Tank wallet has no MATIC. Please fund the tank wallet first:');
    console.log(`   Address: ${tankWallet.address}`);
    console.log('   Minimum recommended: 1 MATIC');
    process.exit(1);
  }
  
  // Create a test escrow address (HD wallet)
  const mnemonic = process.env.HOT_WALLET_SEED;
  if (!mnemonic) {
    console.error('❌ HOT_WALLET_SEED not configured in .env');
    process.exit(1);
  }
  
  const hdWallet = ethers.HDNodeWallet.fromPhrase(mnemonic);
  const escrowWallet = hdWallet.derivePath("m/44'/60'/0'/0/1"); // Test escrow at index 1
  console.log('Test Escrow Address:', escrowWallet.address);
  
  // Check escrow balance
  const escrowBalance = await provider.getBalance(escrowWallet.address);
  console.log('Escrow Balance:', ethers.formatEther(escrowBalance), 'MATIC');
  
  // USDT contract on Polygon
  const USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
  const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function transfer(address to, uint256 amount) returns (bool)'
  ];
  
  const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
  const usdtBalance = await usdtContract.balanceOf(escrowWallet.address);
  const decimals = await usdtContract.decimals();
  
  console.log('Escrow USDT Balance:', ethers.formatUnits(usdtBalance, decimals), 'USDT\n');
  
  if (usdtBalance === 0n) {
    console.log('ℹ️  Escrow has no USDT. For testing, you need to:');
    console.log(`   1. Send some USDT to: ${escrowWallet.address}`);
    console.log('   2. Run this script again');
    console.log('\nThe script will demonstrate gas funding when transferring USDT.');
    return;
  }
  
  // Simulate gas funding scenario
  console.log('📋 Scenario: Transfer USDT from escrow to another address');
  console.log('============================================\n');
  
  // Estimate gas for ERC20 transfer
  const gasLimit = 80000n; // Typical ERC20 transfer with safety margin
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || ethers.parseUnits('30', 'gwei');
  const estimatedGasCost = gasLimit * gasPrice;
  
  console.log('Gas Estimation:');
  console.log('  Gas Limit:', gasLimit.toString());
  console.log('  Gas Price:', ethers.formatUnits(gasPrice, 'gwei'), 'gwei');
  console.log('  Total Cost:', ethers.formatEther(estimatedGasCost), 'MATIC\n');
  
  // Check if escrow needs gas funding
  if (escrowBalance < estimatedGasCost) {
    console.log('⚠️  Escrow needs gas funding!');
    console.log('  Current:', ethers.formatEther(escrowBalance), 'MATIC');
    console.log('  Needed:', ethers.formatEther(estimatedGasCost), 'MATIC');
    
    // Fund escrow from tank
    const fundAmount = ethers.parseEther(process.env.POLYGON_GAS_FUND_AMOUNT || '0.5');
    console.log('\n💰 Funding escrow with', ethers.formatEther(fundAmount), 'MATIC from tank...');
    
    try {
      const fundTx = await tankWallet.sendTransaction({
        to: escrowWallet.address,
        value: fundAmount
      });
      
      console.log('  Transaction:', fundTx.hash);
      console.log('  Waiting for confirmation...');
      
      const receipt = await fundTx.wait();
      console.log('  ✅ Funded! Block:', receipt.blockNumber);
      
      // Check new balance
      const newBalance = await provider.getBalance(escrowWallet.address);
      console.log('  New escrow balance:', ethers.formatEther(newBalance), 'MATIC');
    } catch (error) {
      console.error('❌ Failed to fund escrow:', error.message);
      process.exit(1);
    }
  } else {
    console.log('✅ Escrow has sufficient gas');
  }
  
  // Now simulate the USDT transfer
  console.log('\n📤 Simulating USDT transfer...');
  
  // Test recipient (could be any address)
  const recipient = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0'; // Random address
  const transferAmount = ethers.parseUnits('0.01', decimals); // Transfer 0.01 USDT
  
  if (usdtBalance >= transferAmount) {
    console.log('  From:', escrowWallet.address);
    console.log('  To:', recipient);
    console.log('  Amount:', ethers.formatUnits(transferAmount, decimals), 'USDT');
    
    // Connect escrow wallet to contract
    const escrowSigner = escrowWallet.connect(provider);
    const usdtWithSigner = usdtContract.connect(escrowSigner);
    
    try {
      console.log('  Sending transaction...');
      const transferTx = await usdtWithSigner.transfer(recipient, transferAmount);
      console.log('  Transaction:', transferTx.hash);
      console.log('  Waiting for confirmation...');
      
      const receipt = await transferTx.wait();
      console.log('  ✅ Transfer successful! Block:', receipt.blockNumber);
      console.log('  Gas used:', receipt.gasUsed.toString());
      
      // Check final balances
      const finalEscrowBalance = await provider.getBalance(escrowWallet.address);
      const finalTankBalance = await provider.getBalance(tankWallet.address);
      
      console.log('\n📊 Final Balances:');
      console.log('  Tank:', ethers.formatEther(finalTankBalance), 'MATIC');
      console.log('  Escrow:', ethers.formatEther(finalEscrowBalance), 'MATIC');
      
    } catch (error) {
      if (error.code === 'INSUFFICIENT_FUNDS') {
        console.error('❌ Insufficient gas for transaction');
        console.log('   This means gas funding didn\'t work properly');
      } else {
        console.error('❌ Transfer failed:', error.message);
      }
    }
  } else {
    console.log('  ⚠️  Insufficient USDT balance for test transfer');
    console.log('     Have:', ethers.formatUnits(usdtBalance, decimals), 'USDT');
    console.log('     Need:', ethers.formatUnits(transferAmount, decimals), 'USDT');
  }
  
  console.log('\n✨ Gas Funding Test Complete!');
}

// Run the test
testGasFunding().catch(console.error);