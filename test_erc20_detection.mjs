import { ethers } from 'ethers';
import { EvmPlugin } from './packages/chains/dist/EvmPlugin.js';

async function testERC20Detection() {
  const plugin = new EvmPlugin('POLYGON');
  
  // Initialize with Polygon RPC
  await plugin.init({
    chainId: 'POLYGON',
    rpcUrl: 'https://polygon-rpc.com',
    confirmations: 30,
    collectConfirms: 30,
    operator: { address: '0x0000000000000000000000000000000000000000' }
  });
  
  const escrowAddress = '0xEAf75E03E01Db6cF23ae6d09E4a5E495B852EDC9';
  
  console.log('Testing ERC20 deposit detection for escrow:', escrowAddress);
  console.log('');
  
  // Test with USDT@POLYGON (as Engine would pass it)
  console.log('1. Testing with asset code: USDT@POLYGON');
  try {
    const deposits1 = await plugin.listConfirmedDeposits(
      'USDT@POLYGON',
      escrowAddress,
      1  // min 1 confirmation
    );
    console.log('Result:', JSON.stringify(deposits1, null, 2));
  } catch (error) {
    console.log('Error:', error.message);
  }
  
  console.log('\n2. Testing with asset code: USDT');
  try {
    const deposits2 = await plugin.listConfirmedDeposits(
      'USDT',
      escrowAddress,
      1
    );
    console.log('Result:', JSON.stringify(deposits2, null, 2));
  } catch (error) {
    console.log('Error:', error.message);
  }
  
  console.log('\n3. Testing with asset code: ERC20:0xc2132D05D31c914a87C6611C10748AEb04B58e8F');
  try {
    const deposits3 = await plugin.listConfirmedDeposits(
      'ERC20:0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      escrowAddress,
      1
    );
    console.log('Result:', JSON.stringify(deposits3, null, 2));
  } catch (error) {
    console.log('Error:', error.message);
  }
}

testERC20Detection().catch(console.error);