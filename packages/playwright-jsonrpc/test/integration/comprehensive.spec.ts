import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PlaywrightRPCClient } from '../../client/examples/basic-usage';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { FixtureServer } from '../fixtures/server';

// Test configuration
const TEST_PORT = 3339;
const FIXTURE_PORT = 3400;
const API_URL = `http://localhost:${TEST_PORT}/rpc`;
const API_KEY = 'test-comprehensive-key-456';
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}`;

describe('Comprehensive Playwright JSON-RPC Integration Tests', () => {
  let serverProcess: ChildProcess;
  let fixtureServer: FixtureServer;
  let client: PlaywrightRPCClient;
  let sessionId: string | null = null;

  beforeAll(async () => {
    // Start fixture server
    fixtureServer = new FixtureServer(FIXTURE_PORT);
    await fixtureServer.start();

    // Set environment variables for test server
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      API_KEY,
      HEADLESS: 'true',
      LOG_LEVEL: 'error',
      ALLOW_HOST_REGEX: `^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/`,
    };

    // Start the RPC server
    serverProcess = spawn('npx', ['ts-node', 'src/server.ts'], {
      env,
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'pipe',
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server failed to start in time'));
      }, 15000);

      serverProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Ready to accept requests')) {
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

  afterAll(async () => {
    // Stop fixture server
    if (fixtureServer) {
      await fixtureServer.stop();
    }

    // Stop RPC server
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        serverProcess.on('exit', resolve);
        setTimeout(resolve, 5000);
      });
    }
  });

  afterEach(async () => {
    if (sessionId) {
      try {
        await client.closeSession(sessionId);
      } catch {
        // Ignore cleanup errors
      }
      sessionId = null;
    }
  });

  describe('Session Management', () => {
    it('should create session with default options', async () => {
      sessionId = await client.createSession();
      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(/^s_[a-f0-9-]+$/);
    });

    it('should create session with custom viewport', async () => {
      sessionId = await client.createSession({
        headless: true,
        viewport: { width: 1920, height: 1080 },
      });
      expect(sessionId).toBeDefined();
    });

    it('should create multiple sessions', async () => {
      const session1 = await client.createSession();
      const session2 = await client.createSession();

      expect(session1).not.toBe(session2);

      await client.closeSession(session1);
      await client.closeSession(session2);
    });

    it('should close session successfully', async () => {
      sessionId = await client.createSession();
      await expect(client.closeSession(sessionId)).resolves.not.toThrow();
      sessionId = null;
    });

    it('should handle closing non-existent session gracefully', async () => {
      await expect(client.closeSession('s_invalid-session-id')).resolves.not.toThrow();
    });

    it('should reject operations on closed session', async () => {
      const tempSession = await client.createSession();
      await client.closeSession(tempSession);

      await expect(client.goto(tempSession, FIXTURE_URL)).rejects.toThrow();
    });
  });

  describe('Navigation Methods', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
    });

    it('should navigate to URL with networkidle', async () => {
      const result = await client.goto(sessionId!, FIXTURE_URL, {
        waitUntil: 'networkidle',
      });

      expect(result.url).toBe(`${FIXTURE_URL}/`);
      expect(result.title).toBe('Interactive Test Fixture - Playwright JSON-RPC');
    });

    it('should navigate with different waitUntil options', async () => {
      const result = await client.goto(sessionId!, FIXTURE_URL, {
        waitUntil: 'load',
      });

      expect(result.url).toBe(`${FIXTURE_URL}/`);
    });

    it('should reload the page', async () => {
      await client.goto(sessionId!, FIXTURE_URL);

      const result = await client.request('page.reload', {
        session_id: sessionId,
        waitUntil: 'load',
      });

      expect(result.url).toBe(`${FIXTURE_URL}/`);
    });

    it('should wait for different page states', async () => {
      await client.goto(sessionId!, FIXTURE_URL);

      await expect(
        client.request('page.waitFor', {
          session_id: sessionId,
          state: 'load',
        })
      ).resolves.toBeDefined();
    });

    it('should wait for idle time', async () => {
      await client.goto(sessionId!, FIXTURE_URL);

      const start = Date.now();
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 1000,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(1000);
    });

    it('should handle navigation timeout', async () => {
      await expect(
        client.goto(sessionId!, `${FIXTURE_URL}/api/slow?delay=10000`, {
          timeout: 2000,
        })
      ).rejects.toThrow();
    }, 10000);
  });

  describe('Content Extraction', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should extract text from page', async () => {
      const text = await client.getText(sessionId!, 'h1');
      expect(text).toContain('Interactive Test Fixture');
    });

    it('should extract text with normalization', async () => {
      const text = await client.getText(sessionId!, 'body', {
        normalize: true,
        maxChars: 500,
      });

      expect(text).toBeDefined();
      expect(text.length).toBeLessThanOrEqual(500);
    });

    it('should extract full HTML content', async () => {
      const result = await client.request<{ html: string }>('page.content', {
        session_id: sessionId,
      });

      expect(result.html).toBeDefined();
      expect(result.html).toContain('<!DOCTYPE html>');
      expect(result.html).toContain('Interactive Test Fixture');
    });

    it('should extract text from specific selector', async () => {
      const text = await client.getText(sessionId!, '.subtitle');
      expect(text).toContain('Comprehensive testing page');
    });

    it('should handle non-existent selector gracefully', async () => {
      const text = await client.getText(sessionId!, '.non-existent-selector-xyz');
      expect(text).toBeDefined();
    });
  });

  describe('Page Evaluation', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should evaluate simple expression', async () => {
      const result = await client.request<{ result: any }>('page.evaluate', {
        session_id: sessionId,
        expression: '1 + 1',
      });

      expect(result.result).toBe(2);
    });

    it('should evaluate DOM query', async () => {
      const result = await client.request<{ result: any }>('page.evaluate', {
        session_id: sessionId,
        expression: 'document.title',
      });

      expect(result.result).toBe('Interactive Test Fixture - Playwright JSON-RPC');
    });

    it('should evaluate function with arguments', async () => {
      const result = await client.request<{ result: any }>('page.evaluate', {
        session_id: sessionId,
        expression: '(arg) => arg * 2',
        arg: 21,
      });

      expect(result.result).toBe(42);
    });

    it('should evaluate complex object', async () => {
      const result = await client.request<{ result: any }>('page.evaluate', {
        session_id: sessionId,
        expression: '({ pages: Array.from(document.querySelectorAll(".page")).length })',
      });

      expect(result.result).toHaveProperty('pages');
      expect(result.result.pages).toBeGreaterThan(0);
    });
  });

  describe('Page Interactions', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should click button and trigger action', async () => {
      await client.click(sessionId!, '#show-alert');

      // Wait a bit for the action to complete
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 500,
      });

      const text = await client.getText(sessionId!, '#home-output');
      expect(text).toContain('Success');
    });

    it('should navigate between pages using navigation buttons', async () => {
      await client.click(sessionId!, 'nav button[data-page="form"]');

      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      const text = await client.getText(sessionId!, 'h2');
      expect(text).toContain('Form Testing');
    });

    it('should fill form inputs', async () => {
      // Navigate to form page
      await client.click(sessionId!, 'nav button[data-page="form"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.fill(sessionId!, '#username', 'testuser');
      await client.fill(sessionId!, '#email', 'test@example.com');
      await client.fill(sessionId!, '#message', 'This is a test message');

      // Verify values were set
      const username = await client.request<{ result: any }>('page.evaluate', {
        session_id: sessionId,
        expression: 'document.getElementById("username").value',
      });

      expect(username.result).toBe('testuser');
    });

    it('should press keys on elements', async () => {
      await client.click(sessionId!, 'nav button[data-page="form"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.fill(sessionId!, '#username', 'test');

      await client.request('page.press', {
        session_id: sessionId,
        selector: '#username',
        key: 'Control+A',
      });

      await client.request('page.press', {
        session_id: sessionId,
        selector: '#username',
        key: 'Delete',
      });

      const value = await client.request<{ result: any }>('page.evaluate', {
        session_id: sessionId,
        expression: 'document.getElementById("username").value',
      });

      expect(value.result).toBe('');
    });

    it('should handle click with modifiers', async () => {
      await client.request('page.click', {
        session_id: sessionId,
        selector: '#show-alert',
        button: 'left',
        clickCount: 1,
      });

      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      const text = await client.getText(sessionId!, '#home-output');
      expect(text).toBeDefined();
    });

    it('should handle element not found error', async () => {
      await expect(
        client.click(sessionId!, '#non-existent-button', { timeout: 2000 })
      ).rejects.toThrow();
    });
  });

  describe('Console Logs and Events', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should capture console.log messages', async () => {
      // Navigate to console page and trigger log
      await client.click(sessionId!, 'nav button[data-page="console"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#log-info');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      const logs = await client.pullLogs(sessionId!);
      const infoLogs = logs.console.filter((log) => log.type === 'log');

      expect(infoLogs.length).toBeGreaterThan(0);
    });

    it('should capture console.warn messages', async () => {
      await client.click(sessionId!, 'nav button[data-page="console"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#log-warn');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 500,
      });

      const logs = await client.pullLogs(sessionId!);
      const warnings = logs.console.filter((log) => log.type === 'warning');

      expect(warnings.length).toBeGreaterThan(0);
    });

    it('should capture console.error messages', async () => {
      await client.click(sessionId!, 'nav button[data-page="console"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#log-error');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 500,
      });

      const logs = await client.pullLogs(sessionId!);
      const errors = logs.console.filter((log) => log.type === 'error');

      expect(errors.length).toBeGreaterThan(0);
    });

    it('should capture page errors (exceptions)', async () => {
      await client.click(sessionId!, 'nav button[data-page="console"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#throw-error');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 1000,
      });

      const logs = await client.pullLogs(sessionId!);

      expect(logs.pageErrors.length).toBeGreaterThan(0);
      expect(logs.pageErrors[0].text).toContain('intentional test exception');
    });

    it('should clear console buffer after pulling', async () => {
      await client.click(sessionId!, '#show-alert');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      const logs1 = await client.pullLogs(sessionId!);
      expect(logs1.console.length).toBeGreaterThan(0);

      const logs2 = await client.pullLogs(sessionId!);
      expect(logs2.console.length).toBe(0);
    });
  });

  describe('Network Monitoring', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should capture successful network requests', async () => {
      await client.click(sessionId!, 'nav button[data-page="api"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#api-success');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 2000,
      });

      const network = await client.pullNetwork(sessionId!, false);
      const projectRequests = network.requests.filter((req) =>
        req.url.includes('/api/projects')
      );

      expect(projectRequests.length).toBeGreaterThan(0);
      expect(projectRequests[0].status).toBe(200);
    });

    it('should capture failed network requests', async () => {
      await client.click(sessionId!, 'nav button[data-page="network"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#failed-request');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 2000,
      });

      const network = await client.pullNetwork(sessionId!, true);
      const errorRequests = network.requests.filter((req) => req.status >= 400);

      expect(errorRequests.length).toBeGreaterThan(0);
    });

    it('should filter network events by error status', async () => {
      await client.click(sessionId!, 'nav button[data-page="api"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#api-error');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 2000,
      });

      const networkErrors = await client.pullNetwork(sessionId!, true);
      const allNetwork = await client.pullNetwork(sessionId!, false);

      expect(networkErrors.requests.length).toBeLessThanOrEqual(allNetwork.requests.length);
    });

    it('should clear network buffer after pulling', async () => {
      await client.click(sessionId!, '#show-alert');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      const network1 = await client.pullNetwork(sessionId!, false);
      const network2 = await client.pullNetwork(sessionId!, false);

      expect(network2.requests.length).toBe(0);
    });
  });

  describe('Screenshot Capture', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should capture viewport screenshot', async () => {
      const screenshot = await client.screenshot(sessionId!, {
        fullPage: false,
      });

      expect(screenshot).toBeDefined();
      expect(screenshot).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(screenshot.length).toBeGreaterThan(1000);
    });

    it('should capture full page screenshot', async () => {
      const screenshot = await client.screenshot(sessionId!, {
        fullPage: true,
      });

      expect(screenshot).toBeDefined();
      expect(screenshot.length).toBeGreaterThan(1000);
    });

    it('should capture screenshot with different MIME types', async () => {
      const pngScreenshot = await client.request<{ base64: string }>('screenshot', {
        session_id: sessionId,
        fullPage: false,
        mime: 'image/png',
      });

      const jpegScreenshot = await client.request<{ base64: string }>('screenshot', {
        session_id: sessionId,
        fullPage: false,
        mime: 'image/jpeg',
      });

      expect(pngScreenshot.base64).toBeDefined();
      expect(jpegScreenshot.base64).toBeDefined();
    });
  });

  describe('Async Operations', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should handle delayed content loading', async () => {
      await client.click(sessionId!, 'nav button[data-page="async"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#delayed-1s');

      // Wait for content to load
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 1500,
      });

      const text = await client.getText(sessionId!, '#async-output');
      expect(text).toContain('loaded after 1 second');
    });

    it('should handle progressive loading', async () => {
      await client.click(sessionId!, 'nav button[data-page="async"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#progressive-load');

      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 3000,
      });

      const text = await client.getText(sessionId!, '#async-output');
      expect(text).toContain('Complete');
    });

    it('should handle fetch and render operations', async () => {
      await client.click(sessionId!, 'nav button[data-page="async"]');
      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 300,
      });

      await client.click(sessionId!, '#fetch-and-render');

      await client.request('page.waitFor', {
        session_id: sessionId,
        state: 'idleFor',
        ms: 2000,
      });

      const text = await client.getText(sessionId!, '#async-output');
      expect(text).toContain('Project Details');
    });
  });

  describe('Accessibility Methods', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
      await client.goto(sessionId, FIXTURE_URL);
    });

    it('should find element by role', async () => {
      const result = await client.request<{ selector: string }>('find.byRole', {
        session_id: sessionId,
        role: 'heading',
        name: 'Welcome to Interactive Test Fixture',
      });

      expect(result.selector).toBeDefined();
      expect(result.selector).toContain('role=heading');
    });

    it('should find button by role and name', async () => {
      const result = await client.request<{ selector: string }>('find.byRole', {
        session_id: sessionId,
        role: 'button',
        name: 'Show Alert Message',
      });

      expect(result.selector).toBeDefined();
      expect(result.selector).toContain('role=button');
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      sessionId = await client.createSession();
    });

    it('should handle invalid session ID', async () => {
      await expect(client.goto('invalid-session', FIXTURE_URL)).rejects.toThrow(/RPC Error/);
    });

    it('should handle missing required parameters', async () => {
      await expect(
        client.request('page.goto', { session_id: sessionId })
      ).rejects.toThrow();
    });

    it('should handle timeout errors gracefully', async () => {
      await client.goto(sessionId!, FIXTURE_URL);

      await expect(
        client.click(sessionId!, '#non-existent-element', { timeout: 1000 })
      ).rejects.toThrow();
    });

    it('should provide meaningful error messages', async () => {
      try {
        await client.goto(sessionId!, 'not-a-valid-url');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('RPC Error');
      }
    });
  });
});
