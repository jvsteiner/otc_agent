
async function checkDealStatus() {
  const dealId = 'e4421ff69fb61939da3f035571bf1c34';
  
  try {
    const response = await fetch('http://localhost:8080/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'otc.status',
        params: { dealId },
        id: 1
      })
    });
    
    const result = await response.json();
    
    if (result.result) {
      console.log('Deal Status:', result.result.stage);
      console.log('\nAlice (UNICITY) Collection:');
      console.log(JSON.stringify(result.result.collection.sideA, null, 2));
      console.log('\nBob (POLYGON) Collection:');
      console.log(JSON.stringify(result.result.collection.sideB, null, 2));
    } else {
      console.log('Error:', result.error);
    }
  } catch (error) {
    console.error('Failed to fetch status:', error);
  }
}

checkDealStatus();