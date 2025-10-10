#!/usr/bin/env ts-node

/**
 * OTC Broker Party Page Testing Example
 *
 * Demonstrates automated testing of OTC broker party pages using Playwright JSON-RPC.
 * This example shows how to:
 * - Navigate to party pages (Alice/Bob)
 * - Verify deal details and status
 * - Monitor deposit addresses
 * - Check transaction status
 * - Capture error states
 * - Monitor console logs and network errors
 * - Take screenshots for documentation
 *
 * Prerequisites:
 * 1. OTC broker backend running on localhost:8080
 * 2. Playwright JSON-RPC service running
 * 3. Set API_KEY environment variable
 * 4. Run: npx ts-node client/examples/otc-broker-testing.ts <dealId> <token>
 */

import { PlaywrightRPCClient } from './basic-usage';
import { ResilientRPCClient } from './error-handling';

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:3337/rpc';
const API_KEY = process.env.API_KEY || 'dev-key-123';
const OTC_BASE_URL = process.env.OTC_BASE_URL || 'http://localhost:8080';

interface DealInfo {
  dealId: string;
  party: 'alice' | 'bob';
  token: string;
  status?: string;
  depositAddress?: string;
  expectedAmount?: string;
  receivingAddress?: string;
  errors: string[];
  warnings: string[];
}

/**
 * OTC Broker testing client with specialized methods
 */
class OTCTestingClient extends ResilientRPCClient {
  /**
   * Navigate to party page and wait for content to load
   */
  async openPartyPage(
    sessionId: string,
    dealId: string,
    party: 'alice' | 'bob',
    token: string
  ): Promise<void> {
    const partyLetter = party === 'alice' ? 'a' : 'b';
    const url = `${OTC_BASE_URL}/d/${dealId}/${partyLetter}/${token}`;

    console.log(`   Navigating to ${party}'s page: ${url}`);

    try {
      const result = await this.goto(sessionId, url, {
        waitUntil: 'networkidle',
        timeout: 10000,
      });

      console.log(`   Page loaded: ${result.title}`);

      // Wait for dynamic content to load
      await this.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 2000,
      });
    } catch (error: any) {
      throw new Error(`Failed to open party page: ${error.message}`);
    }
  }

  /**
   * Extract deal information from the page
   */
  async extractDealInfo(sessionId: string, dealId: string, party: 'alice' | 'bob'): Promise<DealInfo> {
    const info: DealInfo = {
      dealId,
      party,
      token: '',
      errors: [],
      warnings: [],
    };

    try {
      // Get page text for analysis
      const pageText = await this.getText(sessionId, 'body', {
        normalize: true,
        maxChars: 10000,
      });

      // Extract status
      const statusMatch = pageText.match(/Status[:\s]+([A-Z_]+)/i);
      if (statusMatch) {
        info.status = statusMatch[1];
      }

      // Extract deposit address
      const addressMatch = pageText.match(/Deposit[:\s]+([a-zA-Z0-9]{30,})/);
      if (addressMatch) {
        info.depositAddress = addressMatch[1];
      }

      // Extract expected amount
      const amountMatch = pageText.match(/Amount[:\s]+([\d.]+)/);
      if (amountMatch) {
        info.expectedAmount = amountMatch[1];
      }

      // Check for error messages
      const errorText = await this.getText(sessionId, '.error, .alert-danger', {
        normalize: true,
      }).catch(() => '');

      if (errorText) {
        info.errors.push(errorText);
      }

      // Check for warning messages
      const warningText = await this.getText(sessionId, '.warning, .alert-warning', {
        normalize: true,
      }).catch(() => '');

      if (warningText) {
        info.warnings.push(warningText);
      }

      return info;
    } catch (error: any) {
      console.error(`   Error extracting deal info: ${error.message}`);
      return info;
    }
  }

  /**
   * Monitor console logs for errors
   */
  async checkConsoleErrors(sessionId: string): Promise<string[]> {
    try {
      const logs = await this.pullLogs(sessionId);
      const errors: string[] = [];

      // Check for page errors
      logs.pageErrors.forEach((error) => {
        errors.push(`Page Error: ${error.text}`);
        if (error.stack) {
          errors.push(`  Stack: ${error.stack.split('\n')[0]}`);
        }
      });

      // Check for console errors
      logs.console.forEach((log) => {
        if (log.type === 'error') {
          errors.push(`Console Error: ${log.text}`);
        }
      });

      return errors;
    } catch (error: any) {
      console.error(`   Failed to check console errors: ${error.message}`);
      return [];
    }
  }

  /**
   * Monitor network requests for failures
   */
  async checkNetworkErrors(sessionId: string): Promise<string[]> {
    try {
      const network = await this.pullNetwork(sessionId, true);
      const errors: string[] = [];

      network.requests.forEach((req) => {
        if (req.status >= 400 || req.status === 0) {
          errors.push(`Network Error: ${req.method} ${req.url} - Status: ${req.status}`);
        }
      });

      return errors;
    } catch (error: any) {
      console.error(`   Failed to check network errors: ${error.message}`);
      return [];
    }
  }

  /**
   * Verify deposit address is displayed
   */
  async verifyDepositAddress(sessionId: string): Promise<boolean> {
    try {
      // Look for common deposit address patterns
      const pageText = await this.getText(sessionId, 'body', { normalize: true });

      // Check for address-like strings (alphanumeric, 30+ chars)
      const hasAddress = /[a-zA-Z0-9]{30,}/.test(pageText);

      // Check for QR code (common in deposit pages)
      const hasQrCode = await this.request<{ result: boolean }>('page.evaluate', {
        session_id: sessionId,
        expression: 'document.querySelector("img[alt*=QR], canvas") !== null',
      });

      return hasAddress || hasQrCode.result;
    } catch (error: any) {
      console.error(`   Failed to verify deposit address: ${error.message}`);
      return false;
    }
  }

  /**
   * Check deal status and stage
   */
  async checkDealStatus(sessionId: string): Promise<{ status: string; stage: string } | null> {
    try {
      const result = await this.request<{ result: any }>('page.evaluate', {
        session_id: sessionId,
        expression: `({
          status: document.querySelector('[data-status]')?.dataset.status || 'unknown',
          stage: document.querySelector('[data-stage]')?.dataset.stage || 'unknown'
        })`,
      });

      return result.result;
    } catch (error: any) {
      console.error(`   Failed to check deal status: ${error.message}`);
      return null;
    }
  }

  /**
   * Take screenshot with timestamp
   */
  async captureScreenshot(sessionId: string, filename: string): Promise<void> {
    try {
      const screenshot = await this.screenshot(sessionId, { fullPage: true });

      // In a real implementation, you would save this to a file
      console.log(`   Screenshot captured: ${filename} (${screenshot.length} bytes)`);

      // For demonstration, just log the first 100 chars
      console.log(`   Data: ${screenshot.substring(0, 100)}...`);
    } catch (error: any) {
      console.error(`   Failed to capture screenshot: ${error.message}`);
    }
  }
}

/**
 * Test a party page comprehensively
 */
async function testPartyPage(
  client: OTCTestingClient,
  dealId: string,
  party: 'alice' | 'bob',
  token: string
): Promise<void> {
  console.log(`\nTesting ${party.toUpperCase()}'s Page (Deal: ${dealId})`);
  console.log('='.repeat(60));

  let sessionId: string | null = null;

  try {
    // Create session
    console.log('\n1. Creating browser session...');
    sessionId = await client.createSessionSafe();
    if (!sessionId) {
      throw new Error('Failed to create session');
    }

    // Navigate to party page
    console.log('\n2. Opening party page...');
    await client.openPartyPage(sessionId, dealId, party, token);

    // Extract deal information
    console.log('\n3. Extracting deal information...');
    const dealInfo = await client.extractDealInfo(sessionId, dealId, party);

    console.log(`   Deal ID: ${dealInfo.dealId}`);
    console.log(`   Status: ${dealInfo.status || 'N/A'}`);
    console.log(`   Deposit Address: ${dealInfo.depositAddress || 'N/A'}`);
    console.log(`   Expected Amount: ${dealInfo.expectedAmount || 'N/A'}`);

    if (dealInfo.errors.length > 0) {
      console.log(`   Errors found: ${dealInfo.errors.length}`);
      dealInfo.errors.forEach((err) => console.log(`     - ${err}`));
    }

    if (dealInfo.warnings.length > 0) {
      console.log(`   Warnings found: ${dealInfo.warnings.length}`);
      dealInfo.warnings.forEach((warn) => console.log(`     - ${warn}`));
    }

    // Verify deposit address
    console.log('\n4. Verifying deposit address display...');
    const hasDepositAddress = await client.verifyDepositAddress(sessionId);
    console.log(`   Deposit address displayed: ${hasDepositAddress ? 'YES' : 'NO'}`);

    // Check deal status
    console.log('\n5. Checking deal status...');
    const status = await client.checkDealStatus(sessionId);
    if (status) {
      console.log(`   Status: ${status.status}`);
      console.log(`   Stage: ${status.stage}`);
    }

    // Check console errors
    console.log('\n6. Checking console errors...');
    const consoleErrors = await client.checkConsoleErrors(sessionId);
    if (consoleErrors.length > 0) {
      console.log(`   Console errors found: ${consoleErrors.length}`);
      consoleErrors.forEach((err) => console.log(`     - ${err}`));
    } else {
      console.log('   No console errors');
    }

    // Check network errors
    console.log('\n7. Checking network errors...');
    const networkErrors = await client.checkNetworkErrors(sessionId);
    if (networkErrors.length > 0) {
      console.log(`   Network errors found: ${networkErrors.length}`);
      networkErrors.forEach((err) => console.log(`     - ${err}`));
    } else {
      console.log('   No network errors');
    }

    // Capture screenshot
    console.log('\n8. Capturing screenshot...');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await client.captureScreenshot(sessionId, `${party}-${dealId}-${timestamp}.png`);

    console.log('\nTest completed successfully!');
  } catch (error: any) {
    console.error(`\nTest failed: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }

    // Try to capture screenshot on error
    if (sessionId) {
      console.log('\nAttempting to capture error screenshot...');
      await client.captureScreenshot(sessionId, `error-${party}-${dealId}.png`);
    }
  } finally {
    if (sessionId) {
      console.log('\nCleaning up...');
      await client.closeSessionSafe(sessionId);
    }
  }
}

/**
 * Monitor party page for changes
 */
async function monitorPartyPage(
  client: OTCTestingClient,
  dealId: string,
  party: 'alice' | 'bob',
  token: string,
  intervalSeconds = 30,
  durationMinutes = 5
): Promise<void> {
  console.log(`\nMonitoring ${party.toUpperCase()}'s page for ${durationMinutes} minutes`);
  console.log('='.repeat(60));

  const sessionId = await client.createSessionSafe();
  if (!sessionId) {
    throw new Error('Failed to create session');
  }

  try {
    await client.openPartyPage(sessionId, dealId, party, token);

    let lastStatus = '';
    const endTime = Date.now() + durationMinutes * 60 * 1000;
    let iteration = 0;

    while (Date.now() < endTime) {
      iteration++;
      console.log(`\n[${new Date().toLocaleTimeString()}] Check #${iteration}`);

      // Reload page
      await client.request('page.reload', { session_id: sessionId });
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 2000,
      });

      // Get current status
      const dealInfo = await client.extractDealInfo(sessionId, dealId, party);
      const currentStatus = dealInfo.status || 'unknown';

      if (currentStatus !== lastStatus) {
        console.log(`   Status changed: ${lastStatus || 'initial'} -> ${currentStatus}`);
        lastStatus = currentStatus;

        // Capture screenshot on status change
        await client.captureScreenshot(
          sessionId,
          `monitor-${party}-${dealId}-${currentStatus}.png`
        );
      } else {
        console.log(`   Status unchanged: ${currentStatus}`);
      }

      // Check for errors
      const consoleErrors = await client.checkConsoleErrors(sessionId);
      const networkErrors = await client.checkNetworkErrors(sessionId);

      if (consoleErrors.length > 0 || networkErrors.length > 0) {
        console.log(`   Errors detected: Console(${consoleErrors.length}), Network(${networkErrors.length})`);
      }

      // Wait before next check
      if (Date.now() + intervalSeconds * 1000 < endTime) {
        console.log(`   Waiting ${intervalSeconds}s before next check...`);
        await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
      }
    }

    console.log('\nMonitoring completed');
  } finally {
    await client.closeSessionSafe(sessionId);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('OTC Broker Party Page Testing');
  console.log('================================\n');

  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: npx ts-node otc-broker-testing.ts <dealId> <token> [party] [mode]');
    console.log('');
    console.log('Arguments:');
    console.log('  dealId  - The deal ID to test');
    console.log('  token   - Authentication token for the party');
    console.log('  party   - alice or bob (default: alice)');
    console.log('  mode    - test or monitor (default: test)');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node otc-broker-testing.ts deal123 abc-def-ghi alice test');
    process.exit(1);
  }

  const dealId = args[0];
  const token = args[1];
  const party = (args[2] || 'alice') as 'alice' | 'bob';
  const mode = args[3] || 'test';

  const client = new OTCTestingClient(API_URL, API_KEY);

  try {
    if (mode === 'monitor') {
      await monitorPartyPage(client, dealId, party, token, 30, 5);
    } else {
      await testPartyPage(client, dealId, party, token);
    }
  } catch (error: any) {
    console.error('\nFatal error:', error.message);
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

export { OTCTestingClient };
