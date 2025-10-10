#!/usr/bin/env ts-node

/**
 * Basic usage example of the Playwright JSON-RPC service
 *
 * Prerequisites:
 * 1. Start the service: npm run dev
 * 2. Set API_KEY environment variable or update the constant below
 * 3. Run this example: npx ts-node client/examples/basic-usage.ts
 */

import fetch from 'node-fetch';

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:3337/rpc';
const API_KEY = process.env.API_KEY || 'dev-key-123';

/**
 * JSON-RPC client class
 */
class PlaywrightRPCClient {
  private requestId = 0;

  constructor(
    private apiUrl: string,
    private apiKey: string
  ) {}

  /**
   * Make a JSON-RPC request
   */
  async request<T = any>(method: string, params?: any): Promise<T> {
    const requestId = ++this.requestId;

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json() as any;

    if (data.error) {
      throw new Error(`RPC Error ${data.error.code}: ${data.error.message}`);
    }

    return data.result;
  }

  /**
   * Create a new browser session
   */
  async createSession(options?: {
    headless?: boolean;
    viewport?: { width: number; height: number };
  }): Promise<string> {
    const result = await this.request<{ session_id: string }>('session.create', options);
    return result.session_id;
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.request('session.close', { session_id: sessionId });
  }

  /**
   * Navigate to a URL
   */
  async goto(
    sessionId: string,
    url: string,
    options?: { waitUntil?: string; timeout?: number }
  ): Promise<{ url: string; title: string }> {
    return this.request('page.goto', {
      session_id: sessionId,
      url,
      ...options,
    });
  }

  /**
   * Get visible text from the page
   */
  async getText(
    sessionId: string,
    selector?: string,
    options?: { maxChars?: number; normalize?: boolean }
  ): Promise<string> {
    const result = await this.request<{ text: string }>('page.text', {
      session_id: sessionId,
      selector,
      ...options,
    });
    return result.text;
  }

  /**
   * Click an element
   */
  async click(sessionId: string, selector: string, options?: { timeout?: number }): Promise<void> {
    await this.request('page.click', {
      session_id: sessionId,
      selector,
      ...options,
    });
  }

  /**
   * Fill an input field
   */
  async fill(
    sessionId: string,
    selector: string,
    value: string,
    options?: { timeout?: number }
  ): Promise<void> {
    await this.request('page.fill', {
      session_id: sessionId,
      selector,
      value,
      ...options,
    });
  }

  /**
   * Pull console logs
   */
  async pullLogs(sessionId: string): Promise<{
    console: Array<{ type: string; text: string }>;
    pageErrors: Array<{ type: string; text: string; stack?: string }>;
  }> {
    return this.request('logs.pull', { session_id: sessionId });
  }

  /**
   * Pull network errors
   */
  async pullNetwork(
    sessionId: string,
    onlyErrors = true
  ): Promise<{ requests: Array<{ url: string; status: number }> }> {
    return this.request('network.pull', {
      session_id: sessionId,
      onlyErrors,
    });
  }

  /**
   * Take a screenshot
   */
  async screenshot(
    sessionId: string,
    options?: { fullPage?: boolean }
  ): Promise<string> {
    const result = await this.request<{ base64: string }>('screenshot', {
      session_id: sessionId,
      ...options,
    });
    return result.base64;
  }
}

/**
 * Main example function
 */
async function main() {
  const client = new PlaywrightRPCClient(API_URL, API_KEY);
  let sessionId: string | null = null;

  try {
    console.log('🚀 Starting Playwright JSON-RPC example...\n');

    // Create a session
    console.log('1. Creating browser session...');
    sessionId = await client.createSession({
      headless: true,
      viewport: { width: 1280, height: 800 },
    });
    console.log(`   ✅ Session created: ${sessionId}\n`);

    // Navigate to a test page
    console.log('2. Navigating to example.com...');
    const navResult = await client.goto(sessionId, 'https://example.com', {
      waitUntil: 'networkidle',
    });
    console.log(`   ✅ Navigated to: ${navResult.url}`);
    console.log(`   📄 Page title: ${navResult.title}\n`);

    // Get page text
    console.log('3. Extracting visible text...');
    const text = await client.getText(sessionId, 'body', {
      maxChars: 500,
      normalize: true,
    });
    console.log('   📝 Page text (first 200 chars):');
    console.log(`   "${text.substring(0, 200)}..."\n`);

    // Check for console logs
    console.log('4. Checking console logs...');
    const logs = await client.pullLogs(sessionId);
    console.log(`   📊 Console messages: ${logs.console.length}`);
    console.log(`   ❌ Page errors: ${logs.pageErrors.length}\n`);

    // Check network errors
    console.log('5. Checking network errors...');
    const network = await client.pullNetwork(sessionId, true);
    console.log(`   🌐 Failed requests: ${network.requests.length}\n`);

    // Take a screenshot
    console.log('6. Taking screenshot...');
    const screenshot = await client.screenshot(sessionId, { fullPage: false });
    console.log(`   📸 Screenshot captured (${screenshot.length} bytes base64)\n`);

    // Navigate to a form page (if available)
    console.log('7. Testing form interactions (optional)...');
    try {
      // This is an example - replace with an actual form URL
      await client.goto(sessionId, 'https://www.w3schools.com/html/html_forms.asp');

      // Try to interact with form elements
      await client.fill(sessionId, 'input[name="firstname"]', 'John', { timeout: 5000 });
      await client.fill(sessionId, 'input[name="lastname"]', 'Doe', { timeout: 5000 });
      console.log('   ✅ Form fields filled successfully\n');
    } catch (error) {
      console.log('   ⚠️ Form interaction skipped (elements not found)\n');
    }

    console.log('✨ Example completed successfully!');

  } catch (error) {
    console.error('\n❌ Error occurred:', error);
    process.exitCode = 1;
  } finally {
    // Clean up: close the session
    if (sessionId) {
      console.log('\n🧹 Cleaning up...');
      try {
        await client.closeSession(sessionId);
        console.log('   ✅ Session closed');
      } catch (error) {
        console.error('   ❌ Failed to close session:', error);
      }
    }
  }
}

// Run the example
if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { PlaywrightRPCClient };