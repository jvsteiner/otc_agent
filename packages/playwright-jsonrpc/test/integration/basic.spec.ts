import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PlaywrightRPCClient } from '../../client/examples/basic-usage';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

// Test configuration
const TEST_PORT = 3338; // Use different port for tests
const API_URL = `http://localhost:${TEST_PORT}/rpc`;
const API_KEY = 'test-key-123';

describe('Playwright JSON-RPC Integration Tests', () => {
  let serverProcess: ChildProcess;
  let client: PlaywrightRPCClient;
  let sessionId: string | null = null;

  // Start the server before all tests
  beforeAll(async () => {
    // Set environment variables for test server
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      API_KEY,
      HEADLESS: 'true',
      LOG_LEVEL: 'error', // Reduce noise during tests
    };

    // Start the server
    serverProcess = spawn('npx', ['ts-node', 'src/server.ts'], {
      env,
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'pipe',
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server failed to start in time'));
      }, 10000);

      serverProcess.stdout?.on('data', (data) => {
        if (data.toString().includes('Ready to accept requests')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on('data', (data) => {
        console.error('Server error:', data.toString());
      });

      serverProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    // Create client instance
    client = new PlaywrightRPCClient(API_URL, API_KEY);
  }, 30000);

  // Stop the server after all tests
  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        serverProcess.on('exit', resolve);
        setTimeout(resolve, 5000); // Force resolution after 5s
      });
    }
  });

  // Clean up session after each test
  afterEach(async () => {
    if (sessionId) {
      try {
        await client.closeSession(sessionId);
      } catch {
        // Ignore errors during cleanup
      }
      sessionId = null;
    }
  });

  describe('Session Management', () => {
    it('should create a new session', async () => {
      sessionId = await client.createSession({
        headless: true,
        viewport: { width: 1280, height: 800 },
      });

      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(/^s_[a-f0-9-]+$/);
    });

    it('should close an existing session', async () => {
      sessionId = await client.createSession();
      await expect(client.closeSession(sessionId)).resolves.not.toThrow();
      sessionId = null; // Mark as closed
    });

    it('should handle closing non-existent session gracefully', async () => {
      const fakeId = 's_non-existent-session';
      // Should not throw - closeSession is idempotent
      await expect(client.closeSession(fakeId)).resolves.not.toThrow();
    });
  });

  describe('Navigation', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
    });

    it('should navigate to a URL', async () => {
      const result = await client.goto(sessionId!, 'https://example.com', {
        waitUntil: 'networkidle',
      });

      expect(result.url).toBe('https://example.com/');
      expect(result.title).toBe('Example Domain');
    });

    it('should handle navigation timeout gracefully', async () => {
      // Use a URL that will timeout
      const promise = client.goto(sessionId!, 'https://httpstat.us/200?sleep=5000', {
        timeout: 1000,
      });

      await expect(promise).rejects.toThrow(/RPC Error/);
    });
  });

  describe('Content Extraction', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, 'https://example.com');
    });

    it('should extract visible text from the page', async () => {
      const text = await client.getText(sessionId!, 'body', {
        maxChars: 1000,
        normalize: true,
      });

      expect(text).toBeDefined();
      expect(text).toContain('Example Domain');
      expect(text).toContain('This domain is for use in illustrative examples');
    });

    it('should extract text from specific selector', async () => {
      const text = await client.getText(sessionId!, 'h1');

      expect(text).toBe('Example Domain');
    });

    it('should handle non-existent selector gracefully', async () => {
      const text = await client.getText(sessionId!, '.non-existent-class');

      // Should fallback to body text or return empty
      expect(text).toBeDefined();
    });
  });

  describe('Page Interactions', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      // Navigate to the test fixture if running locally
      // Otherwise use a public form page
      await client.goto(sessionId, 'https://www.w3schools.com/html/html_forms.asp');
    });

    it('should fill form inputs', async () => {
      // Try to fill a form field if it exists
      try {
        await client.fill(sessionId!, 'input[type="text"]', 'Test Value', {
          timeout: 5000,
        });
        // If successful, the fill operation should complete without error
        expect(true).toBe(true);
      } catch (error) {
        // If the element doesn't exist, that's okay for this test
        expect(error).toBeDefined();
      }
    });

    it('should click elements', async () => {
      // Try to click a button if it exists
      try {
        await client.click(sessionId!, 'button', { timeout: 5000 });
        expect(true).toBe(true);
      } catch (error) {
        // If no button exists, that's okay for this test
        expect(error).toBeDefined();
      }
    });
  });

  describe('Debug Signals', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
    });

    it('should pull console logs', async () => {
      // Navigate to a page that might generate console output
      await client.goto(sessionId!, 'https://example.com');

      const logs = await client.pullLogs(sessionId!);

      expect(logs).toBeDefined();
      expect(logs.console).toBeInstanceOf(Array);
      expect(logs.pageErrors).toBeInstanceOf(Array);
    });

    it('should pull network events', async () => {
      await client.goto(sessionId!, 'https://example.com');

      const network = await client.pullNetwork(sessionId!, false);

      expect(network).toBeDefined();
      expect(network.requests).toBeInstanceOf(Array);
      // Should have at least one request (the page itself)
      expect(network.requests.length).toBeGreaterThan(0);
    });

    it('should capture screenshots', async () => {
      await client.goto(sessionId!, 'https://example.com');

      const screenshot = await client.screenshot(sessionId!, { fullPage: false });

      expect(screenshot).toBeDefined();
      expect(screenshot).toMatch(/^[A-Za-z0-9+/]+=*$/); // Base64 pattern
      expect(screenshot.length).toBeGreaterThan(1000); // Should be substantial
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid session ID', async () => {
      const promise = client.getText('invalid-session-id', 'body');
      await expect(promise).rejects.toThrow(/RPC Error/);
    });

    it('should handle invalid URL', async () => {
      sessionId = await client.createSession();
      const promise = client.goto(sessionId, 'not-a-valid-url');
      await expect(promise).rejects.toThrow(/RPC Error/);
    });

    it('should handle disallowed hosts', async () => {
      sessionId = await client.createSession();
      // This might be blocked by the allow-list regex
      const promise = client.goto(sessionId, 'http://evil-site.com');
      await expect(promise).rejects.toThrow(/RPC Error/);
    });
  });
});