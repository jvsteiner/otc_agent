import type { Request, Response, NextFunction } from 'express';
import { URLNotAllowedError } from './types';

/**
 * Express middleware to validate API key from x-api-key header
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware function
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expectedKey = process.env.API_KEY;

  // Server misconfiguration check
  if (!expectedKey) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Server misconfigured: API_KEY not set',
      },
      id: null,
    });
    return;
  }

  const providedKey = req.get('x-api-key');

  // Validate API key
  if (!providedKey || providedKey !== expectedKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized: Invalid or missing API key',
      },
      id: null,
    });
    return;
  }

  next();
}

/**
 * Host allowlist regex compiled from environment variable
 * Defaults to localhost/127.0.0.1 with any port
 */
let allowHostRegex: RegExp;

/**
 * Initialize or reinitialize the host allowlist regex
 */
function initializeAllowHostRegex(): void {
  const pattern = process.env.ALLOW_HOST_REGEX || '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/';

  try {
    allowHostRegex = new RegExp(pattern);
  } catch (error) {
    console.error(`Invalid ALLOW_HOST_REGEX pattern: ${pattern}`, error);
    // Fallback to safe default
    allowHostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;
  }
}

// Initialize on module load
initializeAllowHostRegex();

/**
 * Checks if a URL is allowed based on the host allowlist regex
 *
 * @param url - URL to validate
 * @returns True if URL is allowed, false otherwise
 */
export function isAllowedHost(url: string): boolean {
  try {
    // Ensure regex is initialized
    if (!allowHostRegex) {
      initializeAllowHostRegex();
    }

    return allowHostRegex.test(url);
  } catch (error) {
    console.error('Error testing URL against allowlist:', error);
    return false;
  }
}

/**
 * Validates a URL against the allowlist and throws if not allowed
 *
 * @param url - URL to validate
 * @throws URLNotAllowedError if URL is not allowed
 */
export function validateAllowedHost(url: string): void {
  if (!isAllowedHost(url)) {
    throw new URLNotAllowedError(url);
  }
}

/**
 * Normalizes text by cleaning up whitespace and newlines
 * This is exported from util.ts but re-exported here for backward compatibility
 * with the spec's security.ts module
 *
 * @param text - Text to normalize
 * @returns Normalized text
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r/g, '') // Remove carriage returns
    .replace(/[ \t]+\n/g, '\n') // Remove trailing whitespace from lines
    .replace(/\n{3,}/g, '\n\n') // Collapse 3+ newlines to 2
    .trim();
}

/**
 * Sanitizes user input by removing potentially dangerous characters
 * Used for logging and error messages to prevent injection attacks
 *
 * @param input - Input to sanitize
 * @returns Sanitized string
 */
export function sanitizeInput(input: unknown): string {
  const str = String(input);
  // Remove control characters except newlines and tabs
  return str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Validates that content length is within acceptable limits
 *
 * @param content - Content to check
 * @param maxBytes - Maximum allowed bytes
 * @returns True if within limits
 */
export function validateContentLength(content: string, maxBytes: number): boolean {
  const bytes = Buffer.byteLength(content, 'utf8');
  return bytes <= maxBytes;
}

/**
 * Configuration for security settings
 */
export interface SecurityConfig {
  /** Maximum allowed sessions */
  maxSessions: number;
  /** Session timeout in milliseconds */
  sessionTTL: number;
  /** Maximum content size in bytes */
  maxContentBytes: number;
  /** Rate limit window in milliseconds */
  rateLimitWindow: number;
  /** Maximum requests per window */
  rateLimitMax: number;
}

/**
 * Gets security configuration from environment variables with defaults
 *
 * @returns Security configuration
 */
export function getSecurityConfig(): SecurityConfig {
  return {
    maxSessions: Number(process.env.MAX_SESSIONS ?? 8),
    sessionTTL: Number(process.env.SESSION_TTL_MS ?? 120_000), // 2 minutes default
    maxContentBytes: Number(process.env.MAX_CONTENT_BYTES ?? 524_288), // 512KB default
    rateLimitWindow: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000), // 1 minute
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 120),
  };
}

/**
 * Express middleware to validate JSON-RPC request structure
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware function
 */
export function validateJsonRpcRequest(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;

  // Check if body is an object
  if (!body || typeof body !== 'object') {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Invalid Request: body must be an object',
      },
      id: null,
    });
    return;
  }

  // Validate JSON-RPC version
  if (body.jsonrpc !== '2.0') {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Invalid Request: jsonrpc must be "2.0"',
      },
      id: body.id ?? null,
    });
    return;
  }

  // Validate method exists and is a string
  if (!body.method || typeof body.method !== 'string') {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Invalid Request: method must be a non-empty string',
      },
      id: body.id ?? null,
    });
    return;
  }

  next();
}
