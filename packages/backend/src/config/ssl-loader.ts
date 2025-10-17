/**
 * @fileoverview SSL/TLS certificate loader for HTTPS server configuration.
 * Automatically detects SSL certificates in the .ssl folder and validates them.
 * Supports various certificate naming conventions and provides detailed error reporting.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

/**
 * SSL certificate configuration containing the key and certificate files.
 */
export interface SslConfig {
  /** Private key content (PEM format) */
  key: string;
  /** Certificate content (PEM format) */
  cert: string;
  /** Optional certificate chain/bundle content (PEM format) */
  ca?: string;
  /** Path to the SSL directory */
  sslDir: string;
}

/**
 * Result of SSL certificate loading attempt.
 */
export interface SslLoadResult {
  /** Whether SSL certificates were found and loaded successfully */
  success: boolean;
  /** SSL configuration if successful, null otherwise */
  config: SslConfig | null;
  /** Error message if loading failed */
  error?: string;
  /** Additional information about the loading process */
  info?: string;
}

/**
 * Standard certificate file naming patterns to search for.
 * Order matters - first found match will be used.
 */
const CERT_PATTERNS = {
  // Common naming patterns for certificate files
  cert: [
    'cert.pem',
    'certificate.pem',
    'server.crt',
    'server.cert',
    'fullchain.pem',  // Let's Encrypt
    'cert.crt',
    'certificate.crt',
  ],
  // Common naming patterns for private key files
  key: [
    'key.pem',
    'private.pem',
    'privatekey.pem',
    'server.key',
    'privkey.pem',  // Let's Encrypt
    'private.key',
  ],
  // Optional: Certificate Authority chain/bundle
  ca: [
    'chain.pem',     // Let's Encrypt
    'ca-bundle.pem',
    'ca.pem',
    'ca-bundle.crt',
  ],
};

/**
 * Attempts to load SSL certificates from the specified directory.
 *
 * @param projectRoot - Root directory of the project
 * @returns SslLoadResult containing success status and configuration
 *
 * @example
 * const result = loadSslCertificates('/path/to/project');
 * if (result.success) {
 *   const httpsServer = https.createServer(result.config!, app);
 * }
 */
export function loadSslCertificates(projectRoot: string): SslLoadResult {
  const sslDir = path.join(projectRoot, '.ssl');

  // Check if .ssl directory exists
  if (!fs.existsSync(sslDir)) {
    return {
      success: false,
      config: null,
      info: 'No .ssl directory found - HTTPS disabled, running in HTTP mode',
    };
  }

  // Check if directory is readable
  try {
    fs.accessSync(sslDir, fs.constants.R_OK);
  } catch (error) {
    return {
      success: false,
      config: null,
      error: `SSL directory exists but is not readable: ${sslDir}`,
    };
  }

  // Find certificate file
  const certPath = findFile(sslDir, CERT_PATTERNS.cert);
  if (!certPath) {
    return {
      success: false,
      config: null,
      error: `No certificate file found in ${sslDir}. Expected one of: ${CERT_PATTERNS.cert.join(', ')}`,
    };
  }

  // Find private key file
  const keyPath = findFile(sslDir, CERT_PATTERNS.key);
  if (!keyPath) {
    return {
      success: false,
      config: null,
      error: `No private key file found in ${sslDir}. Expected one of: ${CERT_PATTERNS.key.join(', ')}`,
    };
  }

  // Load certificate and key contents
  try {
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');

    // Optional: Load CA bundle/chain if present
    const caPath = findFile(sslDir, CERT_PATTERNS.ca);
    const ca = caPath ? fs.readFileSync(caPath, 'utf8') : undefined;

    // Validate certificate and key format
    const validationResult = validateCertificates(cert, key, ca);
    if (!validationResult.valid) {
      return {
        success: false,
        config: null,
        error: `SSL certificate validation failed: ${validationResult.error}`,
      };
    }

    const config: SslConfig = {
      cert,
      key,
      ca,
      sslDir,
    };

    return {
      success: true,
      config,
      info: `SSL certificates loaded successfully from ${sslDir}`,
    };
  } catch (error) {
    return {
      success: false,
      config: null,
      error: `Failed to read SSL certificate files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Finds the first matching file from a list of possible filenames.
 *
 * @param dir - Directory to search in
 * @param patterns - List of filenames to search for
 * @returns Full path to the first matching file, or null if none found
 */
function findFile(dir: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const filePath = path.join(dir, pattern);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Validates SSL certificate and key format.
 * Performs basic checks to ensure the files are valid PEM format.
 *
 * @param cert - Certificate content
 * @param key - Private key content
 * @param ca - Optional CA bundle content
 * @returns Validation result with success status and error message if invalid
 */
function validateCertificates(
  cert: string,
  key: string,
  ca?: string
): { valid: boolean; error?: string } {
  // Check for empty files
  if (!cert || cert.trim().length === 0) {
    return { valid: false, error: 'Certificate file is empty' };
  }

  if (!key || key.trim().length === 0) {
    return { valid: false, error: 'Private key file is empty' };
  }

  // Basic PEM format validation for certificate
  if (!cert.includes('-----BEGIN CERTIFICATE-----') || !cert.includes('-----END CERTIFICATE-----')) {
    return { valid: false, error: 'Certificate file does not appear to be in valid PEM format' };
  }

  // Basic PEM format validation for private key
  const keyPatterns = [
    'BEGIN RSA PRIVATE KEY',
    'BEGIN PRIVATE KEY',
    'BEGIN EC PRIVATE KEY',
    'BEGIN ENCRYPTED PRIVATE KEY',
  ];

  const hasValidKeyFormat = keyPatterns.some(pattern =>
    key.includes(`-----${pattern}-----`)
  );

  if (!hasValidKeyFormat) {
    return { valid: false, error: 'Private key file does not appear to be in valid PEM format' };
  }

  // Validate CA bundle if provided
  if (ca && ca.trim().length > 0) {
    if (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')) {
      return { valid: false, error: 'CA bundle file does not appear to be in valid PEM format' };
    }
  }

  // Additional validation: Try to create a temporary HTTPS server to test certificates
  try {
    const options: https.ServerOptions = {
      cert,
      key,
    };

    if (ca) {
      options.ca = ca;
    }

    // Just create the server options - don't actually start a server
    // This validates that Node.js can parse the certificates
    const testServer = https.createServer(options, (req, res) => {
      res.end();
    });

    // Clean up immediately
    testServer.close();

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Certificates appear invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Lists all files in the SSL directory for debugging purposes.
 *
 * @param projectRoot - Root directory of the project
 * @returns Array of filenames found in .ssl directory, or empty array if directory doesn't exist
 */
export function listSslFiles(projectRoot: string): string[] {
  const sslDir = path.join(projectRoot, '.ssl');

  if (!fs.existsSync(sslDir)) {
    return [];
  }

  try {
    return fs.readdirSync(sslDir);
  } catch (error) {
    console.error(`Failed to read SSL directory: ${error}`);
    return [];
  }
}

/**
 * Gets detailed information about SSL certificate setup for logging.
 *
 * @param projectRoot - Root directory of the project
 * @returns Formatted string with SSL setup information
 */
export function getSslSetupInfo(projectRoot: string): string {
  const sslDir = path.join(projectRoot, '.ssl');
  const files = listSslFiles(projectRoot);

  if (files.length === 0) {
    return `No SSL certificates found. To enable HTTPS:
  1. Create a .ssl directory in the project root: ${sslDir}
  2. Place your SSL certificate files in that directory
  3. Supported certificate filenames: ${CERT_PATTERNS.cert.join(', ')}
  4. Supported key filenames: ${CERT_PATTERNS.key.join(', ')}
  5. Optional CA bundle: ${CERT_PATTERNS.ca.join(', ')}`;
  }

  return `SSL directory found with files: ${files.join(', ')}`;
}
