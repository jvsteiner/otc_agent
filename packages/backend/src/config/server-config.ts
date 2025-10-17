/**
 * @fileoverview Server configuration module with automatic URL detection.
 * Determines the appropriate BASE_URL based on environment, SSL availability,
 * and production mode. Handles development vs production URL construction.
 */

import * as os from 'os';

/**
 * Server protocol type
 */
export type ServerProtocol = 'http' | 'https';

/**
 * Server configuration containing protocol, host, port, and BASE_URL
 */
export interface ServerConfig {
  /** Server protocol (http or https) */
  protocol: ServerProtocol;
  /** Server hostname or IP address */
  host: string;
  /** Server port number */
  port: number;
  /** Complete BASE_URL for generating links */
  baseUrl: string;
  /** Whether SSL/HTTPS is enabled */
  sslEnabled: boolean;
  /** Whether in production mode */
  productionMode: boolean;
  /** HTTP redirect port (only used when SSL is enabled) */
  httpRedirectPort: number;
}

/**
 * Determines the appropriate server configuration based on environment and SSL availability.
 *
 * Configuration priority:
 * 1. Explicit BASE_URL environment variable (highest priority)
 * 2. SSL-based auto-detection (HTTPS on 443, HTTP redirect on 80)
 * 3. Production mode defaults (HTTP on 80)
 * 4. Development mode defaults (HTTP on 8080)
 *
 * @param sslEnabled - Whether SSL certificates are available
 * @param productionMode - Whether running in production mode
 * @returns Complete server configuration
 *
 * @example
 * // Development with no SSL
 * getServerConfig(false, false)
 * // Returns: { protocol: 'http', port: 8080, baseUrl: 'http://localhost:8080' }
 *
 * @example
 * // Production with SSL
 * getServerConfig(true, true)
 * // Returns: { protocol: 'https', port: 443, baseUrl: 'https://your-domain.com' }
 */
export function getServerConfig(sslEnabled: boolean, productionMode: boolean): ServerConfig {
  // Check for explicit BASE_URL override (highest priority)
  const explicitBaseUrl = process.env.BASE_URL;
  if (explicitBaseUrl) {
    const parsed = parseBaseUrl(explicitBaseUrl);
    return {
      ...parsed,
      sslEnabled,
      productionMode,
      httpRedirectPort: 80,
    };
  }

  // Auto-detect configuration based on SSL and production mode
  if (sslEnabled) {
    // SSL enabled: Use HTTPS on 443, with HTTP redirect on 80
    const host = getProductionHost();
    return {
      protocol: 'https',
      host,
      port: 443,
      baseUrl: `https://${host}`,
      sslEnabled: true,
      productionMode,
      httpRedirectPort: 80,
    };
  }

  if (productionMode) {
    // Production without SSL: HTTP on port 80
    const host = getProductionHost();
    return {
      protocol: 'http',
      host,
      port: 80,
      baseUrl: `http://${host}`,
      sslEnabled: false,
      productionMode: true,
      httpRedirectPort: 80, // Not used in HTTP-only mode
    };
  }

  // Development mode: HTTP on 8080
  return {
    protocol: 'http',
    host: 'localhost',
    port: 8080,
    baseUrl: 'http://localhost:8080',
    sslEnabled: false,
    productionMode: false,
    httpRedirectPort: 80, // Not used in development
  };
}

/**
 * Parses a BASE_URL string into protocol, host, and port components.
 *
 * @param baseUrl - BASE_URL string to parse (e.g., 'https://example.com:443')
 * @returns Parsed server configuration components
 */
function parseBaseUrl(baseUrl: string): {
  protocol: ServerProtocol;
  host: string;
  port: number;
  baseUrl: string;
} {
  try {
    const url = new URL(baseUrl);

    // Determine protocol
    const protocol: ServerProtocol = url.protocol === 'https:' ? 'https' : 'http';

    // Extract host (hostname without port)
    const host = url.hostname;

    // Determine port (use explicit port or defaults)
    let port: number;
    if (url.port) {
      port = parseInt(url.port, 10);
    } else {
      port = protocol === 'https' ? 443 : 80;
    }

    // Reconstruct baseUrl without trailing slash
    const reconstructed = `${protocol}://${host}${port === (protocol === 'https' ? 443 : 80) ? '' : `:${port}`}`;

    return {
      protocol,
      host,
      port,
      baseUrl: reconstructed,
    };
  } catch (error) {
    console.warn(`Failed to parse BASE_URL "${baseUrl}": ${error}. Using fallback configuration.`);
    // Fallback to development defaults
    return {
      protocol: 'http',
      host: 'localhost',
      port: 8080,
      baseUrl: 'http://localhost:8080',
    };
  }
}

/**
 * Determines the production host based on environment variables or system detection.
 *
 * Priority:
 * 1. DOMAIN environment variable (e.g., 'example.com')
 * 2. PUBLIC_IP environment variable
 * 3. First non-internal IPv4 address
 * 4. Fallback to 'localhost'
 *
 * @returns Host string for production use
 */
function getProductionHost(): string {
  // Check for explicit DOMAIN environment variable
  const domain = process.env.DOMAIN;
  if (domain && domain.trim().length > 0) {
    return domain.trim();
  }

  // Check for explicit PUBLIC_IP environment variable
  const publicIp = process.env.PUBLIC_IP;
  if (publicIp && publicIp.trim().length > 0) {
    return publicIp.trim();
  }

  // Try to auto-detect public IP from network interfaces
  const detectedIp = detectPublicIp();
  if (detectedIp) {
    return detectedIp;
  }

  // Fallback to localhost (not ideal for production)
  console.warn('No DOMAIN or PUBLIC_IP configured. Using localhost (set DOMAIN or PUBLIC_IP for production)');
  return 'localhost';
}

/**
 * Attempts to detect the public IP address from network interfaces.
 * Returns the first non-internal IPv4 address found.
 *
 * @returns Detected IP address or null if none found
 */
function detectPublicIp(): string | null {
  try {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name];
      if (!iface) continue;

      for (const config of iface) {
        // Skip internal (loopback) addresses and IPv6
        if (config.family === 'IPv4' && !config.internal) {
          return config.address;
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to detect public IP: ${error}`);
  }

  return null;
}

/**
 * Validates that server configuration is appropriate for production deployment.
 * Issues warnings if configuration seems suboptimal.
 *
 * @param config - Server configuration to validate
 */
export function validateServerConfig(config: ServerConfig): void {
  if (!config.productionMode) {
    // No validation needed for development mode
    return;
  }

  // Production mode validations
  const warnings: string[] = [];

  // Check if using localhost in production
  if (config.host === 'localhost' || config.host === '127.0.0.1') {
    warnings.push('Using localhost in production mode - set DOMAIN or PUBLIC_IP environment variable');
  }

  // Warn if not using HTTPS in production
  if (!config.sslEnabled) {
    warnings.push('Running production without SSL/HTTPS - consider adding SSL certificates to .ssl/ directory');
  }

  // Warn if using non-standard ports
  if (config.sslEnabled && config.port !== 443) {
    warnings.push(`Using non-standard HTTPS port ${config.port} - standard is 443`);
  }

  if (!config.sslEnabled && config.port !== 80) {
    warnings.push(`Using non-standard HTTP port ${config.port} - standard is 80`);
  }

  // Log warnings
  if (warnings.length > 0) {
    console.warn('⚠️  Server configuration warnings:');
    warnings.forEach(warning => console.warn(`   - ${warning}`));
  }
}

/**
 * Logs server configuration in a user-friendly format.
 *
 * @param config - Server configuration to display
 */
export function logServerConfig(config: ServerConfig): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('🌐 Server Configuration');
  console.log('───────────────────────────────────────────────────────');
  console.log(`   Mode:         ${config.productionMode ? 'Production' : 'Development'}`);
  console.log(`   Protocol:     ${config.protocol.toUpperCase()}`);
  console.log(`   SSL Enabled:  ${config.sslEnabled ? 'Yes ✓' : 'No ✗'}`);
  console.log(`   Host:         ${config.host}`);
  console.log(`   Port:         ${config.port}`);

  if (config.sslEnabled) {
    console.log(`   HTTP Redirect: Port ${config.httpRedirectPort} → ${config.baseUrl}`);
  }

  console.log('───────────────────────────────────────────────────────');
  console.log(`   BASE_URL:     ${config.baseUrl}`);
  console.log('───────────────────────────────────────────────────────');
  console.log(`   Access:       ${config.baseUrl}`);

  if (config.sslEnabled) {
    console.log(`                 (HTTP requests will redirect to HTTPS)`);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Sets the BASE_URL environment variable to match the server configuration.
 * This ensures all parts of the application use the correct URL.
 *
 * @param config - Server configuration
 */
export function applyServerConfig(config: ServerConfig): void {
  // Only override BASE_URL if it wasn't explicitly set
  if (!process.env.BASE_URL) {
    process.env.BASE_URL = config.baseUrl;
    console.log(`✓ BASE_URL configured: ${config.baseUrl}`);
  } else {
    console.log(`✓ Using explicit BASE_URL: ${process.env.BASE_URL}`);
  }
}
