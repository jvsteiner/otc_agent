/**
 * Text normalization utility for cleaning up visible text from web pages
 *
 * Performs the following operations:
 * - Removes carriage returns
 * - Strips trailing whitespace from lines
 * - Collapses multiple consecutive newlines to at most 2
 * - Trims leading and trailing whitespace
 *
 * @param text - Raw text to normalize
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
 * Creates a structured error response for JSON-RPC
 *
 * @param code - Error code (JSON-RPC standard codes)
 * @param message - Human-readable error message
 * @param data - Optional additional error data
 * @returns JSON-RPC error object
 */
export function createErrorResponse(
  code: number,
  message: string,
  data?: any
): { code: number; message: string; data?: any } {
  const error: { code: number; message: string; data?: any } = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return error;
}

/**
 * Standard JSON-RPC 2.0 error codes
 */
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom application error codes (range: -32000 to -32099)
  SESSION_NOT_FOUND: -32001,
  URL_NOT_ALLOWED: -32002,
  MAX_SESSIONS_EXCEEDED: -32003,
  TIMEOUT_ERROR: -32004,
  SELECTOR_NOT_FOUND: -32005,
  NAVIGATION_ERROR: -32006,
} as const;

/**
 * Validates that a session_id parameter is present and non-empty
 *
 * @param sessionId - Session ID to validate
 * @throws Error if session ID is missing or empty
 */
export function validateSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('session_id parameter is required and must be a non-empty string');
  }
}

/**
 * Validates that a URL is well-formed
 *
 * @param url - URL to validate
 * @throws Error if URL is invalid
 */
export function validateUrl(url: unknown): asserts url is string {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('url parameter is required and must be a non-empty string');
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL format: ${url}`);
  }
}

/**
 * Validates that a selector is present and non-empty
 *
 * @param selector - Selector to validate
 * @throws Error if selector is missing or empty
 */
export function validateSelector(selector: unknown): asserts selector is string {
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new Error('selector parameter is required and must be a non-empty string');
  }
}

/**
 * Safely converts an unknown error to a string message
 *
 * @param error - Error object or value
 * @returns Error message string
 */
export function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Generates a unique session ID
 *
 * @returns Session ID with 's_' prefix
 */
export function generateSessionId(): string {
  // Use crypto.randomUUID() for secure random UUIDs
  const uuid = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : require('crypto').randomUUID();
  return `s_${uuid}`;
}

/**
 * Clamps a number between min and max values
 *
 * @param value - Value to clamp
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Creates a timeout promise that rejects after specified milliseconds
 *
 * @param ms - Timeout in milliseconds
 * @param message - Optional timeout error message
 * @returns Promise that rejects on timeout
 */
export function timeout(ms: number, message?: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message || `Operation timed out after ${ms}ms`));
    }, ms);
  });
}

/**
 * Safely truncates text to a maximum length
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length
 * @returns Truncated text
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

/**
 * Checks if a value is a plain object
 *
 * @param value - Value to check
 * @returns True if value is a plain object
 */
export function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Simple logger interface
 */
export interface Logger {
  error: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  info: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
}

/**
 * Sets up a simple logger based on environment configuration
 *
 * @returns Logger instance
 */
export function setupLogger(): Logger {
  const logLevel = process.env.LOG_LEVEL || 'info';
  const logFormat = process.env.LOG_FORMAT || 'json';

  const levels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };

  const currentLevel = levels[logLevel as keyof typeof levels] ?? 2;

  const formatMessage = (level: string, message: string, args: any[]): string => {
    if (logFormat === 'json') {
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        data: args.length > 0 ? args : undefined,
      });
    }
    const timestamp = new Date().toISOString();
    const argsStr = args.length > 0 ? ' ' + JSON.stringify(args) : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${argsStr}`;
  };

  return {
    error: (message: string, ...args: any[]) => {
      if (currentLevel >= 0) {
        console.error(formatMessage('error', message, args));
      }
    },
    warn: (message: string, ...args: any[]) => {
      if (currentLevel >= 1) {
        console.warn(formatMessage('warn', message, args));
      }
    },
    info: (message: string, ...args: any[]) => {
      if (currentLevel >= 2) {
        console.info(formatMessage('info', message, args));
      }
    },
    debug: (message: string, ...args: any[]) => {
      if (currentLevel >= 3) {
        console.log(formatMessage('debug', message, args));
      }
    },
  };
}
