import express, { Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createRPCServer } from './rpc';
import {
  requireApiKey,
  validateJsonRpcRequest,
  getSecurityConfig,
} from './security';
import {
  ensureBrowser,
  startSessionJanitor,
  shutdown,
  getSessionStats,
} from './sessions';
import { errorToString } from './util';

/**
 * Main application server
 */
const app = express();

/**
 * JSON-RPC server instance
 */
const rpcServer = createRPCServer();

// ============================================================================
// Middleware Configuration
// ============================================================================

/**
 * Security headers middleware
 */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

/**
 * JSON body parser with size limit
 */
const config = getSecurityConfig();
app.use(express.json({
  limit: `${Math.ceil(config.maxContentBytes / 1024)}kb`,
}));

/**
 * Rate limiting middleware
 */
const limiter = rateLimit({
  windowMs: config.rateLimitWindow,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Too many requests, please try again later',
    },
    id: null,
  },
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Too many requests, please try again later',
      },
      id: null,
    });
  },
});

app.use(limiter);

/**
 * Request logging middleware
 */
app.use((req: Request, res: Response, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `${req.method} ${req.path} ${res.statusCode} ${duration}ms`
    );
  });
  next();
});

// ============================================================================
// Routes
// ============================================================================

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response) => {
  const stats = getSessionStats();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    sessions: {
      active: stats.total,
      max: stats.maxSessions,
      oldestAge: stats.oldestSessionAge,
    },
  });
});

/**
 * Main JSON-RPC endpoint
 */
app.post(
  '/rpc',
  requireApiKey,
  validateJsonRpcRequest,
  async (req: Request, res: Response) => {
    try {
      // Process the JSON-RPC request
      const jsonRPCResponse = await rpcServer.receive(req.body);

      if (jsonRPCResponse) {
        res.json(jsonRPCResponse);
      } else {
        // Notification (no response expected)
        res.sendStatus(204);
      }
    } catch (error) {
      console.error('Error processing RPC request:', error);

      // Send error response
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Internal error: ${errorToString(error)}`,
        },
        id: req.body?.id ?? null,
      });
    }
  }
);

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

/**
 * Global error handler
 */
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error('Unhandled error:', err);

  res.status(500).json({
    jsonrpc: '2.0',
    error: {
      code: -32603,
      message: 'Internal server error',
    },
    id: null,
  });
});

// ============================================================================
// Server Lifecycle
// ============================================================================

/**
 * Port to listen on
 */
const PORT = Number(process.env.PORT ?? 3337);

/**
 * Server instance
 */
let server: any = null;

/**
 * Session janitor interval
 */
let janitorInterval: NodeJS.Timeout | null = null;

/**
 * Starts the server
 */
async function start(): Promise<void> {
  try {
    console.log('='.repeat(60));
    console.log('Playwright JSON-RPC Server');
    console.log('='.repeat(60));

    // Initialize browser
    console.log('Initializing browser...');
    await ensureBrowser();

    // Start session janitor
    console.log('Starting session cleanup janitor...');
    janitorInterval = startSessionJanitor();

    // Start HTTP server
    server = app.listen(PORT, () => {
      console.log('='.repeat(60));
      console.log(`Server listening on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`RPC endpoint: http://localhost:${PORT}/rpc`);
      console.log('='.repeat(60));
      console.log('Configuration:');
      console.log(`  Max sessions: ${config.maxSessions}`);
      console.log(`  Session TTL: ${config.sessionTTL}ms`);
      console.log(`  Rate limit: ${config.rateLimitMax} requests per ${config.rateLimitWindow}ms`);
      console.log(`  Max content: ${config.maxContentBytes} bytes`);
      console.log('='.repeat(60));
      console.log('Ready to accept requests');
      console.log('='.repeat(60));
    });

    // Handle server errors
    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
      } else {
        console.error('Server error:', error);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
    });
  }

  // Stop session janitor
  if (janitorInterval) {
    clearInterval(janitorInterval);
    console.log('Session janitor stopped');
  }

  // Shutdown sessions and browser
  await shutdown();

  console.log('Graceful shutdown complete');
  process.exit(0);
}

// ============================================================================
// Signal Handlers
// ============================================================================

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection, just log it
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Exit on uncaught exception after cleanup
  gracefulShutdown('uncaughtException').then(() => process.exit(1));
});

// ============================================================================
// Start Server
// ============================================================================

if (require.main === module) {
  start();
}

// Export for testing
export { app, start, gracefulShutdown };