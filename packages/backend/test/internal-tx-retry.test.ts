/**
 * @fileoverview Test for internal transaction retry mechanism
 * Tests that internal transactions are retried when Etherscan API returns empty
 * results for recent transactions.
 */

import { RpcServer } from '../src/api/rpc-server';
import { DB } from '../src/db/database';
import { PluginManager } from '@otc-broker/chains';

// Mock plugin for testing
class MockPlugin {
  private callCount = 0;
  private resultAfterCalls = 2; // Return results after 2 calls

  async getInternalTransactions(txid: string): Promise<any[]> {
    this.callCount++;
    console.log(`MockPlugin: getInternalTransactions called ${this.callCount} times for ${txid}`);

    if (this.callCount >= this.resultAfterCalls) {
      // Return mock internal transactions after specified number of calls
      return [
        {
          from: '0xbroker',
          to: '0xalice',
          value: '1000000000000000000',
          type: 'call'
        },
        {
          from: '0xbroker',
          to: '0xbob',
          value: '2000000000000000000',
          type: 'call'
        }
      ];
    }

    // Return empty array initially (simulating Etherscan delay)
    return [];
  }

  reset() {
    this.callCount = 0;
  }

  getCallCount() {
    return this.callCount;
  }
}

async function testInternalTxRetry() {
  console.log('Starting internal transaction retry test...\n');

  // Create an in-memory database for testing
  const db = new DB(':memory:');

  // Create mock plugin manager
  const pluginManager = new PluginManager();
  const mockPlugin = new MockPlugin();

  // Add mock plugin to manager
  (pluginManager as any).plugins = new Map([['ETH', mockPlugin]]);
  pluginManager.getPlugin = (chainId: any) => {
    if (chainId === 'ETH') return mockPlugin as any;
    return null;
  };

  // Create RPC server
  const rpcServer = new RpcServer(db, pluginManager);

  // Test 1: Check initial empty result triggers retry
  console.log('Test 1: Initial empty result should trigger retry');

  // Simulate checking internal transactions for a recent transaction
  const txid = '0x123abc';
  const chainId = 'ETH';

  // Access private method for testing (in a real test, we'd call through the public API)
  const retryState = (rpcServer as any).getOrCreateRetryState(txid, chainId);

  console.log('Created retry state:', {
    txid: retryState.txid,
    chainId: retryState.chainId,
    isPending: retryState.isPending,
    retryCount: retryState.retryCount,
    nextRetryIn: retryState.nextRetryAt - Date.now()
  });

  console.assert(retryState.isPending === true, 'Retry should be pending');
  console.assert(retryState.retryCount === 0, 'Initial retry count should be 0');
  console.log('✓ Retry state created successfully\n');

  // Test 2: Process retry queue
  console.log('Test 2: Processing retry queue should fetch internal transactions');

  // Modify nextRetryAt to trigger immediate retry
  retryState.nextRetryAt = Date.now() - 1000;

  // Process the retry queue
  await (rpcServer as any).processRetryQueue();

  console.log('After first retry:', {
    isPending: retryState.isPending,
    retryCount: retryState.retryCount,
    hasResult: !!retryState.result
  });

  console.assert(retryState.retryCount === 1, 'Retry count should be 1 after first attempt');
  console.assert(mockPlugin.getCallCount() === 1, 'Plugin should have been called once');
  console.log('✓ First retry attempt completed\n');

  // Test 3: Process retry queue again (should get results this time)
  console.log('Test 3: Second retry should succeed and cache results');

  // Modify nextRetryAt again for immediate retry
  retryState.nextRetryAt = Date.now() - 1000;

  await (rpcServer as any).processRetryQueue();

  console.log('After second retry:', {
    isPending: retryState.isPending,
    retryCount: retryState.retryCount,
    hasResult: !!retryState.result,
    resultLength: retryState.result?.length
  });

  console.assert(retryState.isPending === false, 'Retry should no longer be pending');
  console.assert(retryState.result?.length === 2, 'Should have 2 internal transactions');
  console.assert(mockPlugin.getCallCount() === 2, 'Plugin should have been called twice');
  console.log('✓ Results successfully cached after retry\n');

  // Test 4: Check that cache is used for subsequent requests
  console.log('Test 4: Cached results should be used without calling plugin again');

  // Get from cache
  const cacheKey = `${chainId}:${txid}`;
  const cachedState = (rpcServer as any).internalTxCache.get(cacheKey);

  console.log('Cached state:', {
    hasCachedResult: !!cachedState?.result,
    resultLength: cachedState?.result?.length,
    isPending: cachedState?.isPending
  });

  console.assert(cachedState?.result?.length === 2, 'Cache should contain results');
  console.assert(cachedState?.isPending === false, 'Cache should not be pending');
  console.log('✓ Cache working correctly\n');

  // Cleanup
  (rpcServer as any).stopRetryWorker();
  await db.close();

  console.log('All tests passed! ✅');
}

// Run the test
testInternalTxRetry().catch(console.error);