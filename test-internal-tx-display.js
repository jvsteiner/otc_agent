#!/usr/bin/env node

// Test script to verify internal transactions are displayed in the GUI

const dealId = 'e451812f7b89d79475de9ad917438463';

async function testInternalTransactionDisplay() {
  try {
    // 1. Get deal status from API
    console.log('Fetching deal status from API...');
    const apiResponse = await fetch('http://213.199.61.236:8080/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'otc.status',
        params: { dealId },
        id: 1
      })
    });

    const apiData = await apiResponse.json();
    const brokerTx = apiData.result.transactions.find(t => t.purpose === 'BROKER_SWAP');

    if (!brokerTx) {
      console.error('❌ No BROKER_SWAP transaction found');
      return;
    }

    console.log('✅ Found BROKER_SWAP transaction:', brokerTx.id);
    console.log('   Transaction ID:', brokerTx.submittedTx?.txid);

    if (brokerTx.internalTransactions) {
      console.log('✅ Internal transactions present:', brokerTx.internalTransactions.length);
      brokerTx.internalTransactions.forEach((itx, i) => {
        console.log(`   ${i + 1}. ${itx.type}: ${itx.value} ETH`);
        console.log(`      From: ${itx.from}`);
        console.log(`      To: ${itx.to}`);
      });
    } else {
      console.error('❌ No internal transactions in API response');
      return;
    }

    // 2. Check if page displays internal transactions
    console.log('\nFetching deal page HTML...');
    const pageResponse = await fetch(`http://213.199.61.236:8080/d/${dealId}/a/b5f4c70c936ad892b28e0e1e42f88fc3`);
    const pageHtml = await pageResponse.text();

    // Check for key indicators that internal transactions are displayed
    const hasDetailsHeader = pageHtml.includes('Broker Transaction Details');
    const hasBrokerTag = pageHtml.includes('tag-broker');
    const hasInternalTxCode = pageHtml.includes('internalTransactions');

    console.log('\nPage analysis:');
    console.log(`   Has "Broker Transaction Details" header: ${hasDetailsHeader ? '✅' : '❌'}`);
    console.log(`   Has broker tag styling: ${hasBrokerTag ? '✅' : '❌'}`);
    console.log(`   Has internal transaction code: ${hasInternalTxCode ? '✅' : '❌'}`);

    // Check if specific transaction addresses are mentioned
    const brokerContractAddr = '0x4c164af901b7cdc1864c91e3ab873e5cf8dce808';
    const hasBrokerContract = pageHtml.toLowerCase().includes(brokerContractAddr.toLowerCase());
    console.log(`   References broker contract: ${hasBrokerContract ? '✅' : '❌'}`);

    // Summary
    console.log('\n=== SUMMARY ===');
    if (hasDetailsHeader && hasBrokerTag && hasInternalTxCode) {
      console.log('✅ Internal transaction display is properly configured');
      console.log('   The page includes all necessary code to display internal transactions.');
      console.log('   Users should see the broker transaction breakdown in the GUI.');
    } else {
      console.log('⚠️  Some components may be missing');
      console.log('   The page may need additional updates to fully display internal transactions.');
    }

  } catch (error) {
    console.error('Error during test:', error.message);
  }
}

testInternalTransactionDisplay();