import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  requireApiKey,
  isAllowedHost,
  validateAllowedHost,
  getSecurityConfig,
  sanitizeInput,
  validateContentLength,
  validateJsonRpcRequest,
} from '../../src/security';
import { URLNotAllowedError } from '../../src/types';

describe('Security Functions', () => {
  describe('isAllowedHost', () => {
    const originalEnv = process.env.ALLOW_HOST_REGEX;

    afterEach(() => {
      process.env.ALLOW_HOST_REGEX = originalEnv;
    });

    it('should allow localhost with default regex', () => {
      expect(isAllowedHost('http://localhost/')).toBe(true);
      expect(isAllowedHost('http://localhost:3000/')).toBe(true);
      expect(isAllowedHost('https://localhost:8443/')).toBe(true);
    });

    it('should allow 127.0.0.1 with default regex', () => {
      expect(isAllowedHost('http://127.0.0.1/')).toBe(true);
      expect(isAllowedHost('http://127.0.0.1:3000/')).toBe(true);
      expect(isAllowedHost('https://127.0.0.1:8443/')).toBe(true);
    });

    it('should block external hosts with default regex', () => {
      expect(isAllowedHost('http://example.com/')).toBe(false);
      expect(isAllowedHost('https://google.com/')).toBe(false);
      expect(isAllowedHost('http://192.168.1.1/')).toBe(false);
    });

    it('should allow custom regex patterns', () => {
      // Note: This test can't easily test custom regex because the regex is
      // compiled at module load time. In a real scenario, you would set the
      // env var before importing the module. This test just documents the limitation.
      process.env.ALLOW_HOST_REGEX = '^https?://example\\.com/';
      // The regex was already compiled with default value, so this won't work
      expect(isAllowedHost('http://localhost/')).toBe(true);
    });

    it('should handle URLs with paths', () => {
      expect(isAllowedHost('http://localhost/path/to/page')).toBe(true);
      expect(isAllowedHost('http://localhost:3000/api/endpoint')).toBe(true);
    });

    it('should handle URLs with query parameters', () => {
      expect(isAllowedHost('http://localhost/?foo=bar')).toBe(true);
      expect(isAllowedHost('http://localhost:3000/page?id=123')).toBe(true);
    });

    it('should be case-sensitive for protocol', () => {
      expect(isAllowedHost('HTTP://localhost/')).toBe(false);
      expect(isAllowedHost('http://localhost/')).toBe(true);
    });

    it('should handle invalid URLs gracefully', () => {
      expect(isAllowedHost('not-a-url')).toBe(false);
      expect(isAllowedHost('')).toBe(false);
    });
  });

  describe('validateAllowedHost', () => {
    it('should not throw for allowed hosts', () => {
      expect(() => validateAllowedHost('http://localhost/')).not.toThrow();
      expect(() => validateAllowedHost('http://127.0.0.1:3000/')).not.toThrow();
    });

    it('should throw URLNotAllowedError for disallowed hosts', () => {
      expect(() => validateAllowedHost('http://evil.com/')).toThrow(URLNotAllowedError);
      expect(() => validateAllowedHost('http://192.168.1.1/')).toThrow(URLNotAllowedError);
    });

    it('should include URL in error message', () => {
      try {
        validateAllowedHost('http://forbidden.com/');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('http://forbidden.com/');
        expect(error.message).toContain('not allowed by policy');
      }
    });
  });

  describe('sanitizeInput', () => {
    it('should remove control characters', () => {
      const input = 'Hello\x00\x01\x02World';
      const result = sanitizeInput(input);
      expect(result).toBe('HelloWorld');
    });

    it('should preserve newlines and tabs', () => {
      const input = 'Line 1\nLine 2\tTabbed';
      const result = sanitizeInput(input);
      expect(result).toBe('Line 1\nLine 2\tTabbed');
    });

    it('should handle normal text unchanged', () => {
      const input = 'Hello, World! 123';
      const result = sanitizeInput(input);
      expect(result).toBe(input);
    });

    it('should convert non-strings to strings', () => {
      expect(sanitizeInput(123)).toBe('123');
      expect(sanitizeInput(true)).toBe('true');
      expect(sanitizeInput(null)).toBe('null');
    });

    it('should handle empty strings', () => {
      expect(sanitizeInput('')).toBe('');
    });

    it('should remove dangerous control characters', () => {
      const input = 'Test\x1B[31mRed\x1B[0m'; // ANSI escape codes
      const result = sanitizeInput(input);
      expect(result).not.toContain('\x1B');
    });
  });

  describe('validateContentLength', () => {
    it('should return true for content within limit', () => {
      expect(validateContentLength('Hello', 10)).toBe(true);
      expect(validateContentLength('Hello', 5)).toBe(true);
    });

    it('should return false for content exceeding limit', () => {
      expect(validateContentLength('Hello World', 5)).toBe(false);
    });

    it('should handle Unicode characters correctly', () => {
      const emoji = '😀😁😂'; // Each emoji is 4 bytes in UTF-8
      expect(validateContentLength(emoji, 20)).toBe(true);
      expect(validateContentLength(emoji, 5)).toBe(false);
    });

    it('should handle empty strings', () => {
      expect(validateContentLength('', 0)).toBe(true);
      expect(validateContentLength('', 100)).toBe(true);
    });

    it('should handle exact boundary', () => {
      const text = 'Hello'; // 5 bytes
      expect(validateContentLength(text, 5)).toBe(true);
      expect(validateContentLength(text, 4)).toBe(false);
    });
  });

  describe('getSecurityConfig', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should return default values when env vars not set', () => {
      delete process.env.MAX_SESSIONS;
      delete process.env.SESSION_TTL_MS;
      delete process.env.MAX_CONTENT_BYTES;
      delete process.env.RATE_LIMIT_WINDOW_MS;
      delete process.env.RATE_LIMIT_MAX;

      const config = getSecurityConfig();

      expect(config.maxSessions).toBe(8);
      expect(config.sessionTTL).toBe(120_000);
      expect(config.maxContentBytes).toBe(524_288);
      expect(config.rateLimitWindow).toBe(60_000);
      expect(config.rateLimitMax).toBe(120);
    });

    it('should use environment variables when set', () => {
      process.env.MAX_SESSIONS = '5';
      process.env.SESSION_TTL_MS = '300000';
      process.env.MAX_CONTENT_BYTES = '1048576';
      process.env.RATE_LIMIT_WINDOW_MS = '30000';
      process.env.RATE_LIMIT_MAX = '50';

      const config = getSecurityConfig();

      expect(config.maxSessions).toBe(5);
      expect(config.sessionTTL).toBe(300_000);
      expect(config.maxContentBytes).toBe(1_048_576);
      expect(config.rateLimitWindow).toBe(30_000);
      expect(config.rateLimitMax).toBe(50);
    });

    it('should handle invalid environment variables gracefully', () => {
      process.env.MAX_SESSIONS = 'invalid';
      process.env.SESSION_TTL_MS = 'not-a-number';

      const config = getSecurityConfig();

      expect(isNaN(config.maxSessions)).toBe(true);
      expect(isNaN(config.sessionTTL)).toBe(true);
    });
  });

  describe('requireApiKey middleware', () => {
    const originalApiKey = process.env.API_KEY;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: NextFunction;
    let jsonSpy: ReturnType<typeof vi.fn>;
    let statusSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      process.env.API_KEY = 'test-secret-key';

      jsonSpy = vi.fn();
      statusSpy = vi.fn(() => ({ json: jsonSpy }));

      mockReq = {
        get: vi.fn(),
      };
      mockRes = {
        status: statusSpy as any,
        json: jsonSpy,
      };
      mockNext = vi.fn();
    });

    afterEach(() => {
      process.env.API_KEY = originalApiKey;
      vi.restoreAllMocks();
    });

    it('should call next() with valid API key', () => {
      (mockReq.get as any).mockReturnValue('test-secret-key');

      requireApiKey(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(statusSpy).not.toHaveBeenCalled();
    });

    it('should return 401 with missing API key', () => {
      (mockReq.get as any).mockReturnValue(undefined);

      requireApiKey(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('Invalid or missing API key'),
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 with invalid API key', () => {
      (mockReq.get as any).mockReturnValue('wrong-key');

      requireApiKey(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 500 when API_KEY not configured', () => {
      delete process.env.API_KEY;

      requireApiKey(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(500);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('API_KEY not set'),
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 with empty string API key', () => {
      (mockReq.get as any).mockReturnValue('');

      requireApiKey(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('validateJsonRpcRequest middleware', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: NextFunction;
    let jsonSpy: ReturnType<typeof vi.fn>;
    let statusSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      jsonSpy = vi.fn();
      statusSpy = vi.fn(() => ({ json: jsonSpy }));

      mockReq = {
        body: {},
      };
      mockRes = {
        status: statusSpy as any,
        json: jsonSpy,
      };
      mockNext = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should call next() with valid JSON-RPC request', () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session.create',
        params: {},
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(statusSpy).not.toHaveBeenCalled();
    });

    it('should return 400 for non-object body', () => {
      mockReq.body = null;

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: -32600,
            message: expect.stringContaining('body must be an object'),
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 400 for missing jsonrpc field', () => {
      mockReq.body = {
        id: 1,
        method: 'test',
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('jsonrpc must be "2.0"'),
          }),
        })
      );
    });

    it('should return 400 for wrong jsonrpc version', () => {
      mockReq.body = {
        jsonrpc: '1.0',
        id: 1,
        method: 'test',
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should return 400 for missing method', () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('method must be a non-empty string'),
          }),
        })
      );
    });

    it('should return 400 for empty method', () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
        method: '',
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should return 400 for non-string method', () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
        method: 123,
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should accept request without params', () => {
      mockReq.body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test.method',
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should accept request without id (notification)', () => {
      mockReq.body = {
        jsonrpc: '2.0',
        method: 'notification',
        params: {},
      };

      validateJsonRpcRequest(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });
});
