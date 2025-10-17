/**
 * @fileoverview HTTP to HTTPS redirect server.
 * Runs on port 80 to redirect all HTTP traffic to HTTPS when SSL is enabled.
 * Implements permanent redirects (301) for SEO and caching benefits.
 */

import * as http from 'http';
import * as url from 'url';

/**
 * Configuration for the HTTP redirect server
 */
export interface RedirectServerConfig {
  /** Port to listen on for HTTP traffic (typically 80) */
  httpPort: number;
  /** Target HTTPS URL to redirect to (e.g., 'https://example.com') */
  httpsBaseUrl: string;
  /** Whether to preserve the request path and query string */
  preservePath?: boolean;
  /** Whether to use permanent redirect (301) vs temporary (302) */
  permanent?: boolean;
}

/**
 * HTTP to HTTPS redirect server.
 * Handles all incoming HTTP requests and redirects them to HTTPS.
 */
export class HttpRedirectServer {
  private server: http.Server | null = null;
  private config: RedirectServerConfig;

  constructor(config: RedirectServerConfig) {
    this.config = {
      preservePath: true,
      permanent: true,
      ...config,
    };
  }

  /**
   * Starts the HTTP redirect server.
   * Creates a lightweight HTTP server that redirects all traffic to HTTPS.
   *
   * @returns Promise that resolves when server is listening
   *
   * @example
   * const redirectServer = new HttpRedirectServer({
   *   httpPort: 80,
   *   httpsBaseUrl: 'https://example.com',
   * });
   * await redirectServer.start();
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRedirect(req, res);
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EACCES') {
          console.error(`❌ Permission denied to bind to port ${this.config.httpPort}`);
          console.error('   Port 80 requires root/administrator privileges');
          console.error('   Solutions:');
          console.error('   1. Run with sudo (Linux/Mac): sudo node dist/index.js');
          console.error('   2. Grant CAP_NET_BIND_SERVICE: sudo setcap cap_net_bind_service=+ep $(which node)');
          console.error('   3. Use a reverse proxy (nginx, Apache) on port 80 → your app');
          console.error('   4. Disable HTTP redirect and use HTTPS directly');
          reject(error);
        } else if (error.code === 'EADDRINUSE') {
          console.error(`❌ Port ${this.config.httpPort} is already in use`);
          console.error('   Another service is using this port');
          console.error('   Solutions:');
          console.error('   1. Stop the other service using this port');
          console.error(`   2. Check what's using port ${this.config.httpPort}: sudo lsof -i :${this.config.httpPort}`);
          console.error('   3. Use a different port (set PORT environment variable)');
          reject(error);
        } else {
          console.error(`❌ Failed to start HTTP redirect server: ${error.message}`);
          reject(error);
        }
      });

      this.server.listen(this.config.httpPort, () => {
        console.log(`✓ HTTP redirect server listening on port ${this.config.httpPort}`);
        console.log(`  Redirecting all HTTP → ${this.config.httpsBaseUrl}`);
        resolve();
      });
    });
  }

  /**
   * Handles an incoming HTTP request and redirects it to HTTPS.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response object
   */
  private handleRedirect(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Parse the request URL
    const requestUrl = url.parse(req.url || '/');

    // Construct the HTTPS redirect URL
    let redirectUrl: string;

    if (this.config.preservePath) {
      // Preserve the full path and query string
      const fullPath = req.url || '/';
      redirectUrl = `${this.config.httpsBaseUrl}${fullPath}`;
    } else {
      // Redirect to HTTPS base URL only
      redirectUrl = this.config.httpsBaseUrl;
    }

    // Use 301 (permanent) or 302 (temporary) redirect
    const statusCode = this.config.permanent ? 301 : 302;

    // Set redirect headers
    res.writeHead(statusCode, {
      'Location': redirectUrl,
      'Content-Type': 'text/plain',
      // Security headers
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', // HSTS
      'X-Content-Type-Options': 'nosniff',
    });

    // Send a simple response body (some clients require it)
    res.end(`Redirecting to ${redirectUrl}`);

    // Optional: Log redirects (useful for debugging)
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[HTTP→HTTPS] ${req.method} ${req.url} → ${redirectUrl}`);
    }
  }

  /**
   * Stops the HTTP redirect server.
   *
   * @returns Promise that resolves when server is closed
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          console.error(`Failed to stop HTTP redirect server: ${error.message}`);
          reject(error);
        } else {
          console.log('✓ HTTP redirect server stopped');
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Checks if the server is currently running.
   *
   * @returns True if server is running, false otherwise
   */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }
}

/**
 * Creates and starts an HTTP to HTTPS redirect server.
 * Convenience function for simple use cases.
 *
 * @param httpPort - HTTP port to listen on (typically 80)
 * @param httpsBaseUrl - HTTPS URL to redirect to
 * @returns Running HttpRedirectServer instance
 *
 * @example
 * const redirectServer = await startHttpRedirect(80, 'https://example.com');
 */
export async function startHttpRedirect(
  httpPort: number,
  httpsBaseUrl: string
): Promise<HttpRedirectServer> {
  const server = new HttpRedirectServer({
    httpPort,
    httpsBaseUrl,
    preservePath: true,
    permanent: true,
  });

  await server.start();
  return server;
}
