import express from 'express';
import path from 'path';
import type { Server } from 'http';

/**
 * Test fixture server that serves HTML pages and mock API endpoints
 * Used for testing the Playwright JSON-RPC service
 */
export class FixtureServer {
  private app: express.Application;
  private server: Server | null = null;
  private port: number;

  constructor(port = 3400) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Parse JSON bodies
    this.app.use(express.json());

    // Serve static files from fixtures directory
    this.app.use(express.static(path.join(__dirname)));

    // CORS for testing
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // Mock API: Get projects with simulated delay
    this.app.get('/api/projects', async (req, res) => {
      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 500));

      const projects = [
        { id: 1, name: 'Project Alpha', status: 'Active', owner: 'Alice' },
        { id: 2, name: 'Project Beta', status: 'In Progress', owner: 'Bob' },
        { id: 3, name: 'Project Gamma', status: 'Completed', owner: 'Charlie' },
        { id: 4, name: 'Project Delta', status: 'Planning', owner: 'Diana' },
      ];

      res.json({
        success: true,
        data: projects,
        count: projects.length,
      });
    });

    // Mock API: Get single project
    this.app.get('/api/projects/:id', async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const id = parseInt(req.params.id);
      const project = {
        id,
        name: `Project ${id}`,
        status: 'Active',
        owner: 'Test User',
        createdAt: new Date().toISOString(),
      };

      res.json({ success: true, data: project });
    });

    // Mock API: Create project
    this.app.post('/api/projects', async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 300));

      const { name, status, owner } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'Name is required',
        });
      }

      const project = {
        id: Date.now(),
        name,
        status: status || 'Planning',
        owner: owner || 'Unknown',
        createdAt: new Date().toISOString(),
      };

      res.status(201).json({ success: true, data: project });
    });

    // Mock API: Simulate server error
    this.app.get('/api/fail', (req, res) => {
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: 'This endpoint intentionally returns a 500 error for testing',
      });
    });

    // Mock API: Simulate timeout (very slow response)
    this.app.get('/api/slow', async (req, res) => {
      const delay = parseInt(req.query.delay as string) || 10000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      res.json({ success: true, message: 'Slow response completed' });
    });

    // Mock API: Simulate network error (close connection)
    this.app.get('/api/abort', (req, res) => {
      req.socket.destroy();
    });

    // Mock API: Return different status codes
    this.app.get('/api/status/:code', (req, res) => {
      const code = parseInt(req.params.code);
      res.status(code).json({
        statusCode: code,
        message: `Status code ${code} response`,
      });
    });

    // Mock API: Test authentication
    this.app.get('/api/protected', (req, res) => {
      const auth = req.headers.authorization;

      if (!auth || auth !== 'Bearer test-token') {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }

      res.json({
        success: true,
        message: 'Access granted',
        user: 'test-user',
      });
    });

    // Mock API: Echo request body
    this.app.post('/api/echo', (req, res) => {
      res.json({
        success: true,
        echo: req.body,
        headers: req.headers,
      });
    });

    // Form submission endpoint
    this.app.post('/api/form-submit', (req, res) => {
      const { username, email, message } = req.body;

      if (!username || !email || !message) {
        return res.status(400).json({
          success: false,
          error: 'All fields are required',
        });
      }

      res.json({
        success: true,
        message: 'Form submitted successfully',
        data: { username, email, message },
        timestamp: new Date().toISOString(),
      });
    });

    // Serve the main test fixture page
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'interactive.html'));
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: 'Not found',
        path: req.path,
      });
    });
  }

  /**
   * Start the fixture server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          console.log(`Fixture server started on http://localhost:${this.port}`);
          resolve();
        });

        this.server.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            console.error(`Port ${this.port} is already in use`);
          }
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the fixture server
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          console.log('Fixture server stopped');
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Get the server URL
   */
  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  /**
   * Get the server port
   */
  getPort(): number {
    return this.port;
  }
}

// Export singleton instance for convenience
export const fixtureServer = new FixtureServer();
