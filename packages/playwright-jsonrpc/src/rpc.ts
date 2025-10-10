import { JSONRPCServer } from 'json-rpc-2.0';
import type {
  SessionCreateParams,
  SessionCloseParams,
  PageGotoParams,
  PageReloadParams,
  PageWaitForParams,
  PageTextParams,
  PageContentParams,
  PageEvaluateParams,
  PageClickParams,
  PageFillParams,
  PagePressParams,
  LogsPullParams,
  NetworkPullParams,
  ScreenshotParams,
  FindByRoleParams,
} from './types';
import { createSession, getSession, closeSession } from './sessions';
import { validateAllowedHost } from './security';
import {
  validateSessionId,
  validateUrl,
  validateSelector,
  normalizeText,
  truncateText,
  JSON_RPC_ERROR_CODES,
  errorToString,
} from './util';

/**
 * Creates and configures the JSON-RPC server with all methods
 *
 * @returns Configured JSONRPCServer instance
 */
export function createRPCServer(): JSONRPCServer {
  const server = new JSONRPCServer();

  // ============================================================================
  // Session Management Methods
  // ============================================================================

  /**
   * session.create - Creates a new browser session
   */
  server.addMethod('session.create', async (params: SessionCreateParams = {}) => {
    try {
      const sessionId = await createSession(params);
      return { session_id: sessionId };
    } catch (error) {
      console.error('Error creating session:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: `Failed to create session: ${errorToString(error)}`,
      };
    }
  });

  /**
   * session.close - Closes an existing session
   */
  server.addMethod('session.close', async (params: SessionCloseParams) => {
    try {
      validateSessionId(params.session_id);
      await closeSession(params.session_id);
      return { ok: true };
    } catch (error) {
      console.error('Error closing session:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: `Failed to close session: ${errorToString(error)}`,
      };
    }
  });

  // ============================================================================
  // Navigation & Wait Methods
  // ============================================================================

  /**
   * page.goto - Navigate to a URL
   */
  server.addMethod('page.goto', async (params: PageGotoParams) => {
    try {
      validateSessionId(params.session_id);
      validateUrl(params.url);
      validateAllowedHost(params.url);

      const session = getSession(params.session_id);
      const waitUntil = params.waitUntil ?? 'networkidle';
      const timeout = params.timeout ?? 45000;

      await session.page.goto(params.url, { waitUntil, timeout });

      return {
        url: session.page.url(),
        title: await session.page.title(),
      };
    } catch (error) {
      console.error('Error in page.goto:', error);

      // Check for specific error types
      if (errorToString(error).includes('not allowed')) {
        throw {
          code: JSON_RPC_ERROR_CODES.URL_NOT_ALLOWED,
          message: errorToString(error),
        };
      }

      throw {
        code: JSON_RPC_ERROR_CODES.NAVIGATION_ERROR,
        message: `Navigation failed: ${errorToString(error)}`,
      };
    }
  });

  /**
   * page.reload - Reload the current page
   */
  server.addMethod('page.reload', async (params: PageReloadParams) => {
    try {
      validateSessionId(params.session_id);

      const session = getSession(params.session_id);
      const waitUntil = params.waitUntil ?? 'networkidle';
      const timeout = params.timeout ?? 45000;

      await session.page.reload({ waitUntil, timeout });

      return {
        url: session.page.url(),
        title: await session.page.title(),
      };
    } catch (error) {
      console.error('Error in page.reload:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.NAVIGATION_ERROR,
        message: `Reload failed: ${errorToString(error)}`,
      };
    }
  });

  /**
   * page.waitFor - Wait for a specific page state
   */
  server.addMethod('page.waitFor', async (params: PageWaitForParams) => {
    try {
      validateSessionId(params.session_id);

      const session = getSession(params.session_id);

      // Handle special 'idleFor' state
      if (params.state === 'idleFor') {
        const ms = params.ms ?? 1000;
        await session.page.waitForTimeout(ms);
        return { state: params.state };
      }

      // Handle standard load states
      await session.page.waitForLoadState(params.state as any);
      return { state: params.state };
    } catch (error) {
      console.error('Error in page.waitFor:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.TIMEOUT_ERROR,
        message: `Wait failed: ${errorToString(error)}`,
      };
    }
  });

  // ============================================================================
  // Read Methods
  // ============================================================================

  /**
   * page.text - Extract visible text from the page
   */
  server.addMethod('page.text', async (params: PageTextParams) => {
    try {
      validateSessionId(params.session_id);

      const session = getSession(params.session_id);
      const selector = params.selector ?? 'body';
      const maxChars = params.maxChars ?? 90000;
      const normalize = params.normalize ?? true;

      let text: string;

      try {
        // Try to get text from specific selector
        text = await session.page.locator(selector).innerText({ timeout: 15000 });
      } catch {
        // Fallback to full body text using string-based evaluation
        text = await session.page.evaluate('document.body.innerText || ""');
      }

      // Normalize if requested
      if (normalize) {
        text = normalizeText(text);
      }

      // Truncate to max length
      text = truncateText(text, maxChars);

      return { text };
    } catch (error) {
      console.error('Error in page.text:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.SELECTOR_NOT_FOUND,
        message: `Failed to extract text: ${errorToString(error)}`,
      };
    }
  });

  /**
   * page.content - Get the full HTML content
   */
  server.addMethod('page.content', async (params: PageContentParams) => {
    try {
      validateSessionId(params.session_id);

      const session = getSession(params.session_id);
      const html = await session.page.content();

      return { html };
    } catch (error) {
      console.error('Error in page.content:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: `Failed to get content: ${errorToString(error)}`,
      };
    }
  });

  /**
   * page.evaluate - Execute JavaScript in the page context
   */
  server.addMethod('page.evaluate', async (params: PageEvaluateParams) => {
    try {
      validateSessionId(params.session_id);

      if (!params.expression || typeof params.expression !== 'string') {
        throw new Error('expression parameter is required and must be a string');
      }

      const session = getSession(params.session_id);

      // Create a function from the expression and execute it
      // This allows both expressions and function bodies
      const result = await session.page.evaluate(
        new Function('arg', `return (${params.expression});`) as any,
        params.arg
      );

      return { result };
    } catch (error) {
      console.error('Error in page.evaluate:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: `Evaluation failed: ${errorToString(error)}`,
      };
    }
  });

  // ============================================================================
  // Action Methods
  // ============================================================================

  /**
   * page.click - Click an element
   */
  server.addMethod('page.click', async (params: PageClickParams) => {
    try {
      validateSessionId(params.session_id);
      validateSelector(params.selector);

      const session = getSession(params.session_id);
      const button = params.button ?? 'left';
      const timeout = params.timeout ?? 15000;

      await session.page.locator(params.selector).click({
        button,
        modifiers: params.modifiers,
        timeout,
        clickCount: params.clickCount,
      });

      return { ok: true };
    } catch (error) {
      console.error('Error in page.click:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.SELECTOR_NOT_FOUND,
        message: `Click failed: ${errorToString(error)}`,
      };
    }
  });

  /**
   * page.fill - Fill an input element
   */
  server.addMethod('page.fill', async (params: PageFillParams) => {
    try {
      validateSessionId(params.session_id);
      validateSelector(params.selector);

      if (typeof params.value !== 'string') {
        throw new Error('value parameter must be a string');
      }

      const session = getSession(params.session_id);
      const timeout = params.timeout ?? 15000;

      await session.page.locator(params.selector).fill(params.value, { timeout });

      return { ok: true };
    } catch (error) {
      console.error('Error in page.fill:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.SELECTOR_NOT_FOUND,
        message: `Fill failed: ${errorToString(error)}`,
      };
    }
  });

  /**
   * page.press - Press a key on an element
   */
  server.addMethod('page.press', async (params: PagePressParams) => {
    try {
      validateSessionId(params.session_id);
      validateSelector(params.selector);

      if (!params.key || typeof params.key !== 'string') {
        throw new Error('key parameter is required and must be a string');
      }

      const session = getSession(params.session_id);
      const timeout = params.timeout ?? 15000;

      await session.page.locator(params.selector).press(params.key, { timeout });

      return { ok: true };
    } catch (error) {
      console.error('Error in page.press:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.SELECTOR_NOT_FOUND,
        message: `Press failed: ${errorToString(error)}`,
      };
    }
  });

  // ============================================================================
  // Debug Signal Methods
  // ============================================================================

  /**
   * logs.pull - Retrieve and drain console logs and page errors
   */
  server.addMethod('logs.pull', async (params: LogsPullParams) => {
    try {
      validateSessionId(params.session_id);

      const session = getSession(params.session_id);

      // Create output with all console events and filter page errors
      const output = {
        console: [...session.consoleBuf],
        pageErrors: session.consoleBuf.filter((event) => event.type === 'pageerror'),
      };

      // Clear the buffer
      session.consoleBuf.length = 0;

      return output;
    } catch (error) {
      console.error('Error in logs.pull:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: `Failed to pull logs: ${errorToString(error)}`,
      };
    }
  });

  /**
   * network.pull - Retrieve and drain network events
   */
  server.addMethod('network.pull', async (params: NetworkPullParams) => {
    try {
      validateSessionId(params.session_id);

      const session = getSession(params.session_id);
      const onlyErrors = params.onlyErrors ?? true;

      // Filter network events based on onlyErrors flag
      const filtered = session.netBuf.filter(
        (event) => !onlyErrors || event.status === 0 || event.status >= 400
      );

      // Clear the buffer
      session.netBuf.length = 0;

      return { requests: filtered };
    } catch (error) {
      console.error('Error in network.pull:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: `Failed to pull network events: ${errorToString(error)}`,
      };
    }
  });

  /**
   * screenshot - Capture a screenshot
   */
  server.addMethod('screenshot', async (params: ScreenshotParams) => {
    try {
      validateSessionId(params.session_id);

      const session = getSession(params.session_id);
      const fullPage = params.fullPage ?? false;
      const mime = params.mime ?? 'image/png';

      const type = mime === 'image/jpeg' ? 'jpeg' : 'png';
      const buffer = await session.page.screenshot({ fullPage, type });

      return { base64: buffer.toString('base64') };
    } catch (error) {
      console.error('Error in screenshot:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: `Screenshot failed: ${errorToString(error)}`,
      };
    }
  });

  // ============================================================================
  // Accessibility Methods (Optional)
  // ============================================================================

  /**
   * find.byRole - Find element by ARIA role
   */
  server.addMethod('find.byRole', async (params: FindByRoleParams) => {
    try {
      validateSessionId(params.session_id);

      if (!params.role || typeof params.role !== 'string') {
        throw new Error('role parameter is required and must be a string');
      }

      const session = getSession(params.session_id);

      // Build role selector
      let roleSelector = `role=${params.role}`;

      if (params.name) {
        roleSelector += `[name="${params.name}"${params.exact ? ' i' : ''}]`;
      }

      // Verify the element exists
      const locator = session.page.locator(roleSelector);
      await locator.waitFor({ timeout: 5000 });

      return { selector: roleSelector };
    } catch (error) {
      console.error('Error in find.byRole:', error);
      throw {
        code: JSON_RPC_ERROR_CODES.SELECTOR_NOT_FOUND,
        message: `Role not found: ${errorToString(error)}`,
      };
    }
  });

  return server;
}
