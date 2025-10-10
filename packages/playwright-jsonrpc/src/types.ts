import type { BrowserContext, Page } from 'playwright';

/**
 * Session data structure containing browser context, page, and event buffers
 */
export interface Session {
  /** Playwright browser context for isolation */
  ctx: BrowserContext;
  /** Active page in the context */
  page: Page;
  /** Buffer of console messages and page errors */
  consoleBuf: ConsoleEvent[];
  /** Buffer of network response events */
  netBuf: NetworkEvent[];
  /** Timestamp of last session activity (ms since epoch) */
  lastUsed: number;
}

/**
 * Console event captured from the page
 */
export interface ConsoleEvent {
  /** Type of console message (log, warn, error, etc.) or 'pageerror' */
  type: string;
  /** Text content of the message */
  text: string;
  /** Optional stack trace for page errors */
  stack?: string;
}

/**
 * Network event captured from the page
 */
export interface NetworkEvent {
  /** Full URL of the request */
  url: string;
  /** HTTP status code */
  status: number;
  /** HTTP method (GET, POST, etc.) */
  method?: string;
  /** Response timestamp */
  timestamp?: number;
}

// ============================================================================
// RPC Method Parameter Types
// ============================================================================

export interface SessionCreateParams {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  storageState?: any;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
}

export interface SessionCloseParams {
  session_id: string;
}

export interface PageGotoParams {
  session_id: string;
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  timeout?: number;
}

export interface PageReloadParams {
  session_id: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  timeout?: number;
}

export interface PageWaitForParams {
  session_id: string;
  state: 'load' | 'domcontentloaded' | 'networkidle' | 'idleFor';
  ms?: number;
}

export interface PageTextParams {
  session_id: string;
  selector?: string;
  maxChars?: number;
  normalize?: boolean;
}

export interface PageContentParams {
  session_id: string;
}

export interface PageEvaluateParams {
  session_id: string;
  expression: string;
  arg?: any;
}

export interface PageClickParams {
  session_id: string;
  selector: string;
  button?: 'left' | 'right' | 'middle';
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
  timeout?: number;
  clickCount?: number;
}

export interface PageFillParams {
  session_id: string;
  selector: string;
  value: string;
  timeout?: number;
}

export interface PagePressParams {
  session_id: string;
  selector: string;
  key: string;
  timeout?: number;
}

export interface LogsPullParams {
  session_id: string;
}

export interface NetworkPullParams {
  session_id: string;
  onlyErrors?: boolean;
}

export interface ScreenshotParams {
  session_id: string;
  fullPage?: boolean;
  mime?: 'image/png' | 'image/jpeg';
}

export interface FindByRoleParams {
  session_id: string;
  role: string;
  name?: string;
  exact?: boolean;
}

// ============================================================================
// RPC Response Types
// ============================================================================

export interface SessionCreateResult {
  session_id: string;
}

export interface SessionCloseResult {
  ok: boolean;
}

export interface PageGotoResult {
  url: string;
  title: string;
}

export interface PageReloadResult {
  url: string;
  title: string;
}

export interface PageWaitForResult {
  state: string;
}

export interface PageTextResult {
  text: string;
}

export interface PageContentResult {
  html: string;
}

export interface PageEvaluateResult {
  result: any;
}

export interface PageActionResult {
  ok: boolean;
}

export interface LogsPullResult {
  console: ConsoleEvent[];
  pageErrors: ConsoleEvent[];
}

export interface NetworkPullResult {
  requests: NetworkEvent[];
}

export interface ScreenshotResult {
  base64: string;
}

export interface FindByRoleResult {
  selector: string;
}

// ============================================================================
// Error Types
// ============================================================================

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class URLNotAllowedError extends Error {
  constructor(url: string) {
    super(`URL not allowed by policy: ${url}`);
    this.name = 'URLNotAllowedError';
  }
}

export class MaxSessionsExceededError extends Error {
  constructor(max: number) {
    super(`Maximum number of concurrent sessions (${max}) exceeded`);
    this.name = 'MaxSessionsExceededError';
  }
}

export class InvalidParameterError extends Error {
  constructor(param: string, reason: string) {
    super(`Invalid parameter '${param}': ${reason}`);
    this.name = 'InvalidParameterError';
  }
}
