import { ethers } from 'ethers';

async function checkTransaction() {
  const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
  
  const txHash = '0xf11812e705c40441c06e87f453826fba309fe8df7520cf251fb9af7e6487bae8';
  const escrowAddress = '0xEAf75E03E01Db6cF23ae6d09E4a5E495B852EDC9';
  const usdtContract = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
  
  try {
    console.log('Checking transaction:', txHash);
    console.log('Expected escrow address:', escrowAddress);
    console.log('USDT contract on Polygon:', usdtContract);
    console.log('');
    
    // Get transaction
    const tx = await provider.getTransaction(txHash);
    console.log('Transaction details:');
    console.log('  From:', tx.from);
    console.log('  To (contract):', tx.to);
    console.log('  Value:', tx.value.toString(), 'wei');
    console.log('');
    
    // Get receipt
    const receipt = await provider.getTransactionReceipt(txHash);
    console.log('Receipt:');
    console.log('  Status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');
    console.log('  Block:', receipt.blockNumber);
    console.log('  Logs count:', receipt.logs.length);
    console.log('');
    
    // Parse logs for Transfer events
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    
    console.log('Transfer Events:');
    for (const log of receipt.logs) {
      if (log.topics[0] === TRANSFER_TOPIC && log.address.toLowerCase() === usdtContract.toLowerCase()) {
        const from = '0x' + log.topics[1].slice(26);
        const to = '0x' + log.topics[2].slice(26);
        const amount = ethers.formatUnits(log.data, 6); // USDT has 6 decimals
        
        console.log('  USDT Transfer:');
        console.log('    From:', from);
        console.log('    To:', to);
        console.log('    Amount:', amount, 'USDT');
        console.log('    To escrow?:', to.toLowerCase() === escrowAddress.toLowerCase() ? 'YES ✓' : 'NO ✗');
      }
    }
    
    // Check current USDT balance of escrow
    console.log('\nChecking escrow USDT balance...');
    const ERC20_ABI = [
      'function balanceOf(address owner) view returns (uint256)'
    ];
    const usdtToken = new ethers.Contract(usdtContract, ERC20_ABI, provider);
    const balance = await usdtToken.balanceOf(escrowAddress);
    console.log('Escrow USDT balance:', ethers.formatUnits(balance, 6), 'USDT');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkTransaction();