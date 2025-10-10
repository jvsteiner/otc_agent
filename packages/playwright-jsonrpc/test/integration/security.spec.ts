import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fetch from 'node-fetch';

// Test configuration
const TEST_PORT = 3340;
const API_URL = `http://localhost:${TEST_PORT}/rpc`;
const VALID_API_KEY = 'test-security-key-789';
const INVALID_API_KEY = 'wrong-key-123';

/**
 * Security-focused integration tests
 * Tests API key validation, host allowlist, rate limiting, and security configurations
 */
describe('Security Integration Tests', () => {
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    // Set environment variables with strict security settings
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      API_KEY: VALID_API_KEY,
      HEADLESS: 'true',
      LOG_LEVEL: 'error',
      // Only allow localhost
      ALLOW_HOST_REGEX: '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/',
      MAX_SESSIONS: '3',
      SESSION_TTL_MS: '60000', // 1 minute
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_MAX: '20',
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
  }, 30000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        serverProcess.on('exit', resolve);
        setTimeout(resolve, 5000);
      });
    }
  });

  describe('API Key Authentication', () => {
    it('should reject requests without API key', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('Invalid or missing API key');
    });

    it('should reject requests with invalid API key', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': INVALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      const data = (await response.json()) as any;
      expect(data.error.message).toContain('Invalid or missing API key');
    });

    it('should accept requests with valid API key', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.result).toBeDefined();
      expect(data.result.session_id).toBeDefined();

      // Cleanup
      if (data.result?.session_id) {
        await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': VALID_API_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'session.close',
            params: { session_id: data.result.session_id },
          }),
        });
      }
    });

    it('should handle empty API key header', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': '',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
    });

    it('should be case-sensitive for API key header', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': VALID_API_KEY, // Wrong case
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Host Allowlist', () => {
    let sessionId: string;

    beforeEach(async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      const data = (await response.json()) as any;
      sessionId = data.result.session_id;
    });

    afterEach(async () => {
      if (sessionId) {
        await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': VALID_API_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 999,
            method: 'session.close',
            params: { session_id: sessionId },
          }),
        });
      }
    });

    it('should allow navigation to localhost URLs', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'page.goto',
          params: {
            session_id: sessionId,
            url: 'http://localhost:3000/',
            timeout: 5000,
          },
        }),
      });

      const data = (await response.json()) as any;
      // Should not throw allowlist error (might fail with connection error, which is fine)
      if (data.error) {
        expect(data.error.message).not.toContain('not allowed by policy');
      }
    });

    it('should allow navigation to 127.0.0.1 URLs', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'page.goto',
          params: {
            session_id: sessionId,
            url: 'http://127.0.0.1:8080/',
            timeout: 5000,
          },
        }),
      });

      const data = (await response.json()) as any;
      if (data.error) {
        expect(data.error.message).not.toContain('not allowed by policy');
      }
    });

    it('should block navigation to external URLs', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'page.goto',
          params: {
            session_id: sessionId,
            url: 'https://evil-site.com/',
            timeout: 5000,
          },
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('not allowed');
    });

    it('should block navigation to IP addresses outside localhost', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'page.goto',
          params: {
            session_id: sessionId,
            url: 'http://192.168.1.1/',
            timeout: 5000,
          },
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('not allowed');
    });

    it('should validate URL before checking allowlist', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'page.goto',
          params: {
            session_id: sessionId,
            url: 'not-a-valid-url',
            timeout: 5000,
          },
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('Invalid URL');
    });
  });

  describe('Session Limits', () => {
    const sessionIds: string[] = [];

    afterEach(async () => {
      // Cleanup all created sessions
      for (const sid of sessionIds) {
        try {
          await fetch(API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': VALID_API_KEY,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 999,
              method: 'session.close',
              params: { session_id: sid },
            }),
          });
        } catch {
          // Ignore cleanup errors
        }
      }
      sessionIds.length = 0;
    });

    it('should enforce maximum session limit', async () => {
      // Create sessions up to the limit (MAX_SESSIONS = 3)
      for (let i = 0; i < 3; i++) {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': VALID_API_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'session.create',
            params: {},
          }),
        });

        const data = (await response.json()) as any;
        expect(data.result).toBeDefined();
        sessionIds.push(data.result.session_id);
      }

      // Try to create one more session (should fail)
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'session.create',
          params: {},
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('Maximum number of concurrent sessions');
    });

    it('should allow new session after closing one', async () => {
      // Create max sessions
      for (let i = 0; i < 3; i++) {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': VALID_API_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'session.create',
            params: {},
          }),
        });

        const data = (await response.json()) as any;
        sessionIds.push(data.result.session_id);
      }

      // Close one session
      const closedId = sessionIds.pop()!;
      await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'session.close',
          params: { session_id: closedId },
        }),
      });

      // Should now be able to create a new session
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'session.create',
          params: {},
        }),
      });

      const data = (await response.json()) as any;
      expect(data.result).toBeDefined();
      sessionIds.push(data.result.session_id);
    });
  });

  describe('JSON-RPC Request Validation', () => {
    it('should reject non-JSON requests', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: 'not valid json',
      });

      expect(response.status).toBe(400);
    });

    it('should reject requests without jsonrpc field', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error.message).toContain('jsonrpc must be "2.0"');
    });

    it('should reject requests with wrong jsonrpc version', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '1.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error.message).toContain('jsonrpc must be "2.0"');
    });

    it('should reject requests without method field', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          params: {},
        }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error.message).toContain('method must be a non-empty string');
    });

    it('should reject requests with empty method', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: '',
          params: {},
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should handle non-existent methods', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'nonexistent.method',
          params: {},
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32601); // Method not found
    });

    it('should accept valid JSON-RPC request', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.jsonrpc).toBe('2.0');
      expect(data.id).toBe(1);
      expect(data.result).toBeDefined();

      // Cleanup
      if (data.result?.session_id) {
        await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': VALID_API_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'session.close',
            params: { session_id: data.result.session_id },
          }),
        });
      }
    });
  });

  describe('Parameter Validation', () => {
    let sessionId: string;

    beforeEach(async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      const data = (await response.json()) as any;
      sessionId = data.result.session_id;
    });

    afterEach(async () => {
      if (sessionId) {
        await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': VALID_API_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 999,
            method: 'session.close',
            params: { session_id: sessionId },
          }),
        });
      }
    });

    it('should validate required session_id parameter', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'page.goto',
          params: {
            url: 'http://localhost:3000/',
          },
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('session_id');
    });

    it('should validate empty session_id', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'page.goto',
          params: {
            session_id: '',
            url: 'http://localhost:3000/',
          },
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
    });

    it('should validate selector parameter', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'page.click',
          params: {
            session_id: sessionId,
            selector: '',
          },
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('selector');
    });

    it('should validate URL parameter', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'page.goto',
          params: {
            session_id: sessionId,
            url: '',
          },
        }),
      });

      const data = (await response.json()) as any;
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain('url');
    });
  });

  describe('HTTP Security Headers', () => {
    it('should include security headers in response', async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VALID_API_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session.create',
          params: {},
        }),
      });

      // Check for common security headers
      expect(response.headers.get('x-content-type-options')).toBeDefined();
      expect(response.headers.get('x-frame-options')).toBeDefined();

      // Cleanup
      const data = (await response.json()) as any;
      if (data.result?.session_id) {
        await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': VALID_API_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'session.close',
            params: { session_id: data.result.session_id },
          }),
        });
      }
    });

    it('should only accept POST requests', async () => {
      const response = await fetch(API_URL, {
        method: 'GET',
        headers: {
          'x-api-key': VALID_API_KEY,
        },
      });

      expect(response.status).toBe(404);
    });
  });
});
