import { chromium, Browser, ConsoleMessage, Request, Response } from 'playwright';
import type {
  Session,
  SessionCreateParams,
  ConsoleEvent,
  NetworkEvent,
} from './types';
import { MaxSessionsExceededError, SessionNotFoundError } from './types';
import { generateSessionId } from './util';
import { getSecurityConfig } from './security';

/**
 * Global browser instance (singleton)
 */
let browser: Browser | null = null;

/**
 * Map of active sessions
 */
const sessions = new Map<string, Session>();

/**
 * Ensures the browser is initialized and running
 * Creates a new browser instance if one doesn't exist
 *
 * @returns Promise resolving to the browser instance
 */
export async function ensureBrowser(): Promise<Browser> {
  if (!browser) {
    const headless = process.env.HEADLESS !== 'false';
    console.log(`Launching browser (headless: ${headless})...`);

    browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    console.log('Browser launched successfully');
  }

  return browser;
}

/**
 * Creates a new browser session with the specified parameters
 *
 * @param params - Session creation parameters
 * @returns Promise resolving to the session ID
 * @throws MaxSessionsExceededError if max sessions limit is reached
 */
export async function createSession(params: SessionCreateParams = {}): Promise<string> {
  const config = getSecurityConfig();

  // Check session limit
  if (sessions.size >= config.maxSessions) {
    throw new MaxSessionsExceededError(config.maxSessions);
  }

  // Ensure browser is running
  await ensureBrowser();

  // Create browser context with options
  const ctx = await browser!.newContext({
    viewport: params.viewport ?? { width: 1280, height: 800 },
    userAgent: params.userAgent,
    storageState: params.storageState,
    ignoreHTTPSErrors: true,
    proxy: params.proxy,
  });

  // Create a new page
  const page = await ctx.newPage();

  // Initialize event buffers
  const consoleBuf: ConsoleEvent[] = [];
  const netBuf: NetworkEvent[] = [];

  // Set up console message listener
  page.on('console', (msg: ConsoleMessage) => {
    consoleBuf.push({
      type: msg.type(),
      text: msg.text(),
    });
  });

  // Set up page error listener
  page.on('pageerror', (error: Error) => {
    consoleBuf.push({
      type: 'pageerror',
      text: error.message,
      stack: error.stack,
    });
  });

  // Set up network response listener
  page.on('response', (response: Response) => {
    netBuf.push({
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      timestamp: Date.now(),
    });
  });

  // Set up request listener for additional network info
  page.on('requestfailed', (request: Request) => {
    netBuf.push({
      url: request.url(),
      status: 0, // Failed requests don't have a status
      method: request.method(),
      timestamp: Date.now(),
    });
  });

  // Generate unique session ID
  const sessionId = generateSessionId();

  // Create and store session
  const session: Session = {
    ctx,
    page,
    consoleBuf,
    netBuf,
    lastUsed: Date.now(),
  };

  sessions.set(sessionId, session);

  console.log(`Session created: ${sessionId} (total: ${sessions.size}/${config.maxSessions})`);

  return sessionId;
}

/**
 * Retrieves an active session by ID
 *
 * @param sessionId - Session ID to retrieve
 * @returns The session object
 * @throws SessionNotFoundError if session doesn't exist
 */
export function getSession(sessionId: string): Session {
  const session = sessions.get(sessionId);

  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

  // Update last used timestamp
  session.lastUsed = Date.now();

  return session;
}

/**
 * Checks if a session exists
 *
 * @param sessionId - Session ID to check
 * @returns True if session exists
 */
export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/**
 * Closes a session and cleans up its resources
 *
 * @param sessionId - Session ID to close
 * @returns Promise that resolves when session is closed
 */
export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);

  if (!session) {
    // Session already closed or doesn't exist
    return;
  }

  try {
    // Close the browser context (this also closes all pages)
    await session.ctx.close();
  } catch (error) {
    console.error(`Error closing session ${sessionId}:`, error);
  } finally {
    // Remove from map
    sessions.delete(sessionId);
    console.log(`Session closed: ${sessionId} (remaining: ${sessions.size})`);
  }
}

/**
 * Closes all active sessions
 *
 * @returns Promise that resolves when all sessions are closed
 */
export async function closeAllSessions(): Promise<void> {
  console.log(`Closing all sessions (${sessions.size})...`);

  const closePromises = Array.from(sessions.keys()).map((sessionId) =>
    closeSession(sessionId)
  );

  await Promise.all(closePromises);

  console.log('All sessions closed');
}

/**
 * Cleans up idle sessions that have exceeded the TTL
 *
 * @returns Number of sessions closed
 */
export async function cleanupIdleSessions(): Promise<number> {
  const config = getSecurityConfig();
  const now = Date.now();
  let closedCount = 0;

  const sessionsToClose: string[] = [];

  // Find expired sessions
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastUsed > config.sessionTTL) {
      sessionsToClose.push(sessionId);
    }
  }

  // Close expired sessions
  for (const sessionId of sessionsToClose) {
    await closeSession(sessionId);
    closedCount++;
  }

  if (closedCount > 0) {
    console.log(`Cleaned up ${closedCount} idle session(s)`);
  }

  return closedCount;
}

/**
 * Starts the session janitor that periodically cleans up idle sessions
 *
 * @param intervalMs - Interval in milliseconds between cleanup runs (default: 10 seconds)
 * @returns Interval timer ID
 */
export function startSessionJanitor(intervalMs: number = 10_000): NodeJS.Timeout {
  console.log(`Starting session janitor (interval: ${intervalMs}ms)...`);

  return setInterval(async () => {
    try {
      await cleanupIdleSessions();
    } catch (error) {
      console.error('Error in session janitor:', error);
    }
  }, intervalMs);
}

/**
 * Shuts down the browser and closes all sessions
 *
 * @returns Promise that resolves when shutdown is complete
 */
export async function shutdown(): Promise<void> {
  console.log('Shutting down...');

  // Close all sessions
  await closeAllSessions();

  // Close browser
  if (browser) {
    try {
      await browser.close();
      console.log('Browser closed');
    } catch (error) {
      console.error('Error closing browser:', error);
    } finally {
      browser = null;
    }
  }

  console.log('Shutdown complete');
}

// Alias for compatibility with server.ts
export const shutdownAllSessions = shutdown;

/**
 * Gets statistics about active sessions
 *
 * @returns Session statistics
 */
export function getSessionStats(): {
  total: number;
  maxSessions: number;
  oldestSessionAge: number | null;
} {
  const config = getSecurityConfig();
  const now = Date.now();
  let oldestAge: number | null = null;

  for (const session of sessions.values()) {
    const age = now - session.lastUsed;
    if (oldestAge === null || age > oldestAge) {
      oldestAge = age;
    }
  }

  return {
    total: sessions.size,
    maxSessions: config.maxSessions,
    oldestSessionAge: oldestAge,
  };
}
