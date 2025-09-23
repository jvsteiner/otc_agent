#!/usr/bin/env node

// Test script to verify Polygon transaction detection
const { EtherscanAPI } = require('./packages/chains/dist/utils/EtherscanAPI');

async function testPolygonAPI() {
  console.log('Testing Polygon API...\n');
  
  // Create API instance for Polygon
  const api = new EtherscanAPI('POLYGON');
  
  // Test address (you can replace with your escrow address)
  const testAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb8';
  
  console.log('Fetching transactions for:', testAddress);
  console.log('API configured for Polygon');
  
  try {
    const transactions = await api.getTransactionsByAddress(testAddress, 0, 99999999);
    
    if (transactions.length > 0) {
      console.log(`\nFound ${transactions.length} transactions`);
      console.log('First transaction:', transactions[0]);
    } else {
      console.log('\nNo transactions found or API error occurred');
      console.log('Check console for error messages above');
    }
  } catch (error) {
    console.error('Error:', error);
  }
  
  console.log('\nNote: If you see a V2 API deprecation error, you need to:');
  console.log('1. Get a free API key from https://polygonscan.com/apis');
  console.log('2. Set it as environment variable: export POLYGONSCAN_API_KEY=your_key_here');
  console.log('3. Re-run this test');
}

testPolygonAPI();