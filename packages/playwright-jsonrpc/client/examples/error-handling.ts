#!/usr/bin/env ts-node

/**
 * Error Handling Example for Playwright JSON-RPC Service
 *
 * Demonstrates comprehensive error handling patterns including:
 * - Connection errors
 * - Authentication failures
 * - Invalid parameters
 * - Timeout scenarios
 * - Session management errors
 * - Network failures
 * - Graceful degradation
 *
 * Prerequisites:
 * 1. Start the service: npm run dev
 * 2. Set API_KEY environment variable
 * 3. Run: npx ts-node client/examples/error-handling.ts
 */

import { PlaywrightRPCClient } from './basic-usage';

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:3337/rpc';
const API_KEY = process.env.API_KEY || 'dev-key-123';

/**
 * Enhanced client with retry logic and error handling
 */
class ResilientRPCClient extends PlaywrightRPCClient {
  private maxRetries: number;
  private retryDelay: number;

  constructor(apiUrl: string, apiKey: string, maxRetries = 3, retryDelay = 1000) {
    super(apiUrl, apiKey);
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  /**
   * Request with automatic retry on transient failures
   */
  async requestWithRetry<T = any>(
    method: string,
    params?: any,
    retries = this.maxRetries
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.request<T>(method, params);
      } catch (error: any) {
        lastError = error;

        // Don't retry on auth errors or invalid parameters
        if (
          error.message.includes('Unauthorized') ||
          error.message.includes('Invalid parameter') ||
          error.message.includes('not found')
        ) {
          throw error;
        }

        // Log retry attempt
        if (attempt < retries) {
          console.log(
            `   Attempt ${attempt + 1} failed, retrying in ${this.retryDelay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Create session with connection validation
   */
  async createSessionSafe(options?: any): Promise<string | null> {
    try {
      const sessionId = await this.createSession(options);
      console.log(`   Session created successfully: ${sessionId}`);
      return sessionId;
    } catch (error: any) {
      console.error(`   Failed to create session: ${error.message}`);
      return null;
    }
  }

  /**
   * Close session with graceful error handling
   */
  async closeSessionSafe(sessionId: string): Promise<void> {
    try {
      await this.closeSession(sessionId);
      console.log(`   Session closed: ${sessionId}`);
    } catch (error: any) {
      console.warn(`   Warning: Failed to close session: ${error.message}`);
    }
  }
}

/**
 * Test connection to the service
 */
async function testConnection(client: ResilientRPCClient): Promise<boolean> {
  console.log('\n1. Testing Connection...');

  try {
    const sessionId = await client.createSessionSafe();
    if (!sessionId) {
      console.error('   Connection failed - could not create session');
      return false;
    }

    await client.closeSessionSafe(sessionId);
    console.log('   Connection successful');
    return true;
  } catch (error: any) {
    console.error(`   Connection error: ${error.message}`);
    return false;
  }
}

/**
 * Demonstrate authentication error handling
 */
async function testAuthenticationErrors() {
  console.log('\n2. Testing Authentication Errors...');

  // Try with invalid API key
  const invalidClient = new ResilientRPCClient(API_URL, 'invalid-key-123');

  try {
    await invalidClient.createSession();
    console.error('   ERROR: Should have failed with invalid API key');
  } catch (error: any) {
    console.log(`   Expected auth error: ${error.message}`);
  }

  // Try with empty API key
  const emptyKeyClient = new ResilientRPCClient(API_URL, '');

  try {
    await emptyKeyClient.createSession();
    console.error('   ERROR: Should have failed with empty API key');
  } catch (error: any) {
    console.log(`   Expected auth error: ${error.message}`);
  }
}

/**
 * Demonstrate parameter validation errors
 */
async function testParameterValidation(client: ResilientRPCClient) {
  console.log('\n3. Testing Parameter Validation...');

  const sessionId = await client.createSessionSafe();
  if (!sessionId) return;

  try {
    // Test invalid URL
    console.log('   Testing invalid URL...');
    try {
      await client.goto(sessionId, 'not-a-valid-url');
      console.error('   ERROR: Should have failed with invalid URL');
    } catch (error: any) {
      console.log(`   Expected validation error: ${error.message}`);
    }

    // Test missing required parameter
    console.log('   Testing missing parameter...');
    try {
      await client.request('page.goto', {
        session_id: sessionId,
        // Missing 'url' parameter
      });
      console.error('   ERROR: Should have failed with missing parameter');
    } catch (error: any) {
      console.log(`   Expected validation error: ${error.message}`);
    }

    // Test empty selector
    console.log('   Testing empty selector...');
    try {
      await client.click(sessionId, '', { timeout: 1000 });
      console.error('   ERROR: Should have failed with empty selector');
    } catch (error: any) {
      console.log(`   Expected validation error: ${error.message}`);
    }
  } finally {
    await client.closeSessionSafe(sessionId);
  }
}

/**
 * Demonstrate session management errors
 */
async function testSessionErrors(client: ResilientRPCClient) {
  console.log('\n4. Testing Session Management Errors...');

  // Test operations on invalid session
  console.log('   Testing invalid session ID...');
  try {
    await client.goto('invalid-session-id', 'http://localhost/');
    console.error('   ERROR: Should have failed with invalid session');
  } catch (error: any) {
    console.log(`   Expected session error: ${error.message}`);
  }

  // Test operations on closed session
  console.log('   Testing closed session...');
  const sessionId = await client.createSessionSafe();
  if (sessionId) {
    await client.closeSessionSafe(sessionId);

    try {
      await client.goto(sessionId, 'http://localhost/');
      console.error('   ERROR: Should have failed with closed session');
    } catch (error: any) {
      console.log(`   Expected session error: ${error.message}`);
    }
  }

  // Test double close
  console.log('   Testing double close...');
  const sessionId2 = await client.createSessionSafe();
  if (sessionId2) {
    await client.closeSessionSafe(sessionId2);
    await client.closeSessionSafe(sessionId2); // Should not throw
    console.log('   Double close handled gracefully');
  }
}

/**
 * Demonstrate timeout handling
 */
async function testTimeoutHandling(client: ResilientRPCClient) {
  console.log('\n5. Testing Timeout Handling...');

  const sessionId = await client.createSessionSafe();
  if (!sessionId) return;

  try {
    // Test navigation timeout
    console.log('   Testing navigation timeout (this will take a few seconds)...');
    try {
      await client.goto(sessionId, 'http://localhost:99999/', {
        timeout: 2000,
      });
      console.error('   ERROR: Should have timed out');
    } catch (error: any) {
      console.log(`   Expected timeout: ${error.message}`);
    }

    // Navigate to a valid page
    await client.goto(sessionId, 'http://localhost:3000/').catch(() => {
      console.log('   Note: Test server not running, skipping valid navigation');
    });

    // Test element timeout
    console.log('   Testing element selection timeout...');
    try {
      await client.click(sessionId, '#non-existent-element', { timeout: 1000 });
      console.error('   ERROR: Should have timed out');
    } catch (error: any) {
      console.log(`   Expected timeout: ${error.message}`);
    }
  } finally {
    await client.closeSessionSafe(sessionId);
  }
}

/**
 * Demonstrate network error handling
 */
async function testNetworkErrors() {
  console.log('\n6. Testing Network Errors...');

  // Test connection to non-existent server
  console.log('   Testing connection to non-existent server...');
  const badClient = new ResilientRPCClient('http://localhost:99999/rpc', API_KEY);

  try {
    await badClient.createSession();
    console.error('   ERROR: Should have failed with network error');
  } catch (error: any) {
    console.log(`   Expected network error: ${error.message}`);
  }

  // Test malformed URL
  console.log('   Testing malformed service URL...');
  const malformedClient = new ResilientRPCClient('not-a-url', API_KEY);

  try {
    await malformedClient.createSession();
    console.error('   ERROR: Should have failed with URL error');
  } catch (error: any) {
    console.log(`   Expected URL error: ${error.message}`);
  }
}

/**
 * Demonstrate retry logic
 */
async function testRetryLogic(client: ResilientRPCClient) {
  console.log('\n7. Testing Retry Logic...');

  const sessionId = await client.createSessionSafe();
  if (!sessionId) return;

  try {
    console.log('   Testing retry with transient failure...');

    // This will fail but should retry
    try {
      await client.requestWithRetry('page.goto', {
        session_id: sessionId,
        url: 'http://localhost:99999/',
        timeout: 1000,
      });
    } catch (error: any) {
      console.log(`   Failed after retries (expected): ${error.message}`);
    }

    console.log('   Testing no retry with auth error...');

    // This should fail immediately without retry
    const badClient = new ResilientRPCClient(API_URL, 'wrong-key');
    try {
      await badClient.requestWithRetry('session.create', {});
    } catch (error: any) {
      console.log(`   Failed immediately (expected): ${error.message}`);
    }
  } finally {
    await client.closeSessionSafe(sessionId);
  }
}

/**
 * Demonstrate graceful degradation
 */
async function testGracefulDegradation(client: ResilientRPCClient) {
  console.log('\n8. Testing Graceful Degradation...');

  const sessionId = await client.createSessionSafe();
  if (!sessionId) return;

  try {
    // Try to navigate to test page
    console.log('   Attempting to navigate to test page...');
    try {
      const result = await client.goto(sessionId, 'http://localhost:3000/');
      console.log(`   Successfully navigated to: ${result.url}`);
    } catch (error) {
      console.log('   Test server not available, continuing with degraded functionality');
    }

    // Try to interact even if navigation failed
    console.log('   Attempting to read page content...');
    try {
      const text = await client.getText(sessionId, 'body', {
        maxChars: 100,
      });
      console.log(`   Retrieved text (${text.length} chars)`);
    } catch (error: any) {
      console.log(`   Could not retrieve text: ${error.message}`);
    }

    // Always try to capture screenshot for debugging
    console.log('   Capturing screenshot for debugging...');
    try {
      const screenshot = await client.screenshot(sessionId);
      console.log(`   Screenshot captured (${screenshot.length} bytes)`);
    } catch (error: any) {
      console.log(`   Could not capture screenshot: ${error.message}`);
    }
  } finally {
    await client.closeSessionSafe(sessionId);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('Error Handling Examples for Playwright JSON-RPC');
  console.log('================================================\n');

  const client = new ResilientRPCClient(API_URL, API_KEY);

  try {
    // Test connection first
    const connected = await testConnection(client);
    if (!connected) {
      console.error('\nCannot connect to service. Please ensure:');
      console.error('1. Service is running (npm run dev)');
      console.error('2. API_KEY is configured correctly');
      console.error('3. Service is accessible at', API_URL);
      process.exit(1);
    }

    // Run all error handling tests
    await testAuthenticationErrors();
    await testParameterValidation(client);
    await testSessionErrors(client);
    await testTimeoutHandling(client);
    await testNetworkErrors();
    await testRetryLogic(client);
    await testGracefulDegradation(client);

    console.log('\n================================================');
    console.log('All error handling tests completed successfully!');
    console.log('================================================\n');
  } catch (error: any) {
    console.error('\nUnexpected error during tests:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { ResilientRPCClient };
