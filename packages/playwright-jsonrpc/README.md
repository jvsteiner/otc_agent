# Playwright JSON-RPC Browser Automation Service

A headless browser microservice that executes JavaScript, renders pages internally, and exposes a compact JSON-RPC 2.0 API to observe and interact with web applications.

## Features

- **JSON-RPC 2.0 API** over HTTP for browser automation
- **Session Management** with automatic cleanup and TTL
- **Page Navigation** with various wait strategies
- **Content Extraction** (visible text, HTML, JavaScript evaluation)
- **Page Interactions** (click, fill, type, keyboard)
- **Debug Signals** (console logs, network errors, screenshots)
- **Security** (API key authentication, host allowlist, rate limiting)
- **Resource Management** (max concurrent sessions, memory limits)

## Quick Start

### Installation

```bash
# Clone the repository
cd packages/playwright-jsonrpc

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install --with-deps

# Copy environment configuration
cp .env.example .env
# Edit .env and set your API_KEY
```

### Running the Service

#### Development Mode
```bash
npm run dev
```

#### Production Mode
```bash
npm run build
npm start
```

#### Using Docker
```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f playwright-jsonrpc

# Stop services
docker-compose down
```

See [Deployment](#deployment) section for production deployment options.

## API Documentation

### Authentication

All requests require an `x-api-key` header:

```bash
curl -H "x-api-key: your-api-key" \
     -H "Content-Type: application/json" \
     http://localhost:3337/rpc
```

### Core Methods

#### Session Management

**Create Session**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.create",
  "params": {
    "headless": true,
    "viewport": { "width": 1280, "height": 800 }
  }
}
```

**Close Session**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.close",
  "params": {
    "session_id": "s_xxxxx"
  }
}
```

#### Navigation

**Navigate to URL**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "page.goto",
  "params": {
    "session_id": "s_xxxxx",
    "url": "http://localhost:8080",
    "waitUntil": "networkidle",
    "timeout": 45000
  }
}
```

#### Content Reading

**Get Visible Text**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "page.text",
  "params": {
    "session_id": "s_xxxxx",
    "selector": "main",
    "maxChars": 90000,
    "normalize": true
  }
}
```

#### Page Interactions

**Click Element**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "page.click",
  "params": {
    "session_id": "s_xxxxx",
    "selector": "button[type='submit']",
    "timeout": 15000
  }
}
```

**Fill Input**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "page.fill",
  "params": {
    "session_id": "s_xxxxx",
    "selector": "input[name='username']",
    "value": "testuser"
  }
}
```

#### Debug Signals

**Pull Console Logs**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "logs.pull",
  "params": {
    "session_id": "s_xxxxx"
  }
}
```

**Take Screenshot**
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "screenshot",
  "params": {
    "session_id": "s_xxxxx",
    "fullPage": false
  }
}
```

## Complete Method List

### Session Management
- `session.create` - Create new browser session
- `session.close` - Close existing session

### Navigation & Wait
- `page.goto` - Navigate to URL
- `page.reload` - Reload current page
- `page.waitFor` - Wait for page state

### Content Reading
- `page.text` - Get visible text
- `page.content` - Get HTML content
- `page.evaluate` - Execute JavaScript

### Page Actions
- `page.click` - Click element
- `page.fill` - Fill input field
- `page.press` - Press keyboard key

### Debug Signals
- `logs.pull` - Get console logs and errors
- `network.pull` - Get network requests
- `screenshot` - Capture screenshot

### Accessibility
- `find.byRole` - Find element by ARIA role

## Environment Configuration

See `.env.example` for all available configuration options:

```bash
# Core Settings
PORT=3337
API_KEY=your-secure-api-key

# Security
ALLOW_HOST_REGEX=^https?://(localhost|127\.0\.0\.1)(:\d+)?/
MAX_CONCURRENT_SESSIONS=8
SESSION_TTL_MS=120000

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120

# Browser
HEADLESS=true
BROWSER_ARGS=--disable-dev-shm-usage,--no-sandbox
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## Example Client Usage

### Using cURL

```bash
# Set variables
API="http://localhost:3337/rpc"
KEY="your-api-key"

# Create session
SESSION_ID=$(curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"session.create","params":{}}' \
  $API | jq -r '.result.session_id')

# Navigate to page
curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"page.goto\",\"params\":{\"session_id\":\"$SESSION_ID\",\"url\":\"http://localhost:8080\"}}" \
  $API

# Get text content
curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"page.text\",\"params\":{\"session_id\":\"$SESSION_ID\"}}" \
  $API | jq -r '.result.text'

# Close session
curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"session.close\",\"params\":{\"session_id\":\"$SESSION_ID\"}}" \
  $API
```

### Node.js Client Example

```javascript
const fetch = require('node-fetch');

const API = 'http://localhost:3337/rpc';
const API_KEY = 'your-api-key';

async function rpc(method, params) {
  const response = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    })
  });
  return response.json();
}

// Example usage
(async () => {
  // Create session
  const { result: { session_id } } = await rpc('session.create', {});
  console.log('Session created:', session_id);

  // Navigate to page
  await rpc('page.goto', {
    session_id,
    url: 'http://localhost:8080',
    waitUntil: 'networkidle'
  });

  // Get visible text
  const { result: { text } } = await rpc('page.text', {
    session_id,
    selector: 'body'
  });
  console.log('Page text:', text.substring(0, 200));

  // Close session
  await rpc('session.close', { session_id });
  console.log('Session closed');
})();
```

## Architecture

```
┌─────────────────┐
│   HTTP Client   │
└────────┬────────┘
         │ JSON-RPC 2.0
         ↓
┌─────────────────┐
│  Express Server │
├─────────────────┤
│   Middleware    │
│  - Auth (API Key)│
│  - Rate Limit   │
│  - Validation   │
└────────┬────────┘
         ↓
┌─────────────────┐
│  RPC Handlers   │
└────────┬────────┘
         ↓
┌─────────────────┐
│ Session Manager │
├─────────────────┤
│ - Create/Close  │
│ - TTL Cleanup   │
│ - Resource Limits│
└────────┬────────┘
         ↓
┌─────────────────┐
│   Playwright    │
├─────────────────┤
│ - Browser       │
│ - Contexts      │
│ - Pages         │
└─────────────────┘
```

## Security Considerations

1. **API Key Authentication**: All requests require valid API key
2. **Host Allowlist**: URLs are validated against regex pattern
3. **Rate Limiting**: Configurable request limits per time window
4. **Session Limits**: Maximum concurrent sessions enforced
5. **Content Size Limits**: Request/response size restrictions
6. **Input Validation**: All parameters validated and sanitized
7. **No Direct File Access**: Browser runs in sandboxed environment
8. **Resource Cleanup**: Automatic session cleanup on TTL expiry

## Performance Tips

1. **Reuse Sessions**: Create once, perform multiple operations
2. **Use Specific Selectors**: More specific = faster element location
3. **Appropriate Wait Strategies**: Use `networkidle` only when needed
4. **Clean Up Sessions**: Explicitly close when done
5. **Monitor Resource Usage**: Check `/health` endpoint for stats

## Deployment

### Docker Deployment

#### Production Deployment with Docker

```bash
# Build production image
docker build -t playwright-jsonrpc:latest \
  --target production \
  --build-arg NODE_ENV=production \
  .

# Run production container
docker run -d \
  --name playwright-jsonrpc \
  -p 3337:3337 \
  -e API_KEY=your-secure-api-key \
  -e HEADLESS=true \
  -e MAX_CONCURRENT_SESSIONS=8 \
  --restart unless-stopped \
  --memory=2g \
  --cpus=2 \
  playwright-jsonrpc:latest

# Check logs
docker logs -f playwright-jsonrpc

# Health check
curl http://localhost:3337/health
```

#### Docker Compose Deployment

**Production:**
```bash
# Create .env file
cat > .env << EOF
API_KEY=your-secure-api-key-here
HEADLESS=true
SESSION_TTL_MS=120000
MAX_CONCURRENT_SESSIONS=8
EOF

# Start services
docker-compose up -d

# Check status
docker-compose ps
docker-compose logs -f
```

**Development with hot reload:**
```bash
# Start with dev profile
docker-compose --profile dev up -d playwright-jsonrpc-dev

# This mounts source code for hot reload
docker-compose logs -f playwright-jsonrpc-dev
```

**With monitoring (Prometheus + Grafana):**
```bash
# Start with monitoring profile
docker-compose --profile monitoring up -d

# Access:
# - Service: http://localhost:3337
# - Prometheus: http://localhost:9090
# - Grafana: http://localhost:3000 (admin/admin)
```

#### Multi-Stage Build Targets

The Dockerfile includes three build targets:

1. **production** (default): Optimized production image
2. **development**: Development with hot reload support
3. **builder**: Build stage (intermediate)

```bash
# Build specific target
docker build --target development -t playwright-jsonrpc:dev .
docker build --target production -t playwright-jsonrpc:prod .
```

### Kubernetes Deployment

Complete Kubernetes manifests are available in the `k8s/` directory.

#### Quick Start

```bash
# Update configuration
cd k8s/

# Edit secret with your API key
vim secret.yaml

# Edit ingress with your domain
vim ingress.yaml

# Deploy all resources
kubectl apply -k .

# Check deployment
kubectl get all -n playwright-jsonrpc

# View logs
kubectl logs -n playwright-jsonrpc -l app=playwright-jsonrpc -f

# Port forward for testing
kubectl port-forward -n playwright-jsonrpc svc/playwright-jsonrpc 3337:80
```

#### Kubernetes Features

- **High Availability**: 2 replicas with anti-affinity rules
- **Auto-scaling**: HPA scales 2-10 pods based on CPU/memory
- **Security**: Network policies, RBAC, non-root containers
- **Monitoring**: Prometheus annotations for metrics scraping
- **Ingress**: TLS termination with cert-manager support
- **Health Checks**: Liveness, readiness, and startup probes
- **Resource Limits**: CPU and memory limits per pod
- **Pod Disruption Budget**: Ensures availability during updates

See [k8s/README.md](/home/vrogojin/otc_agent/packages/playwright-jsonrpc/k8s/README.md) for detailed Kubernetes deployment guide.

### Cloud Platform Deployments

#### AWS ECS/Fargate

```bash
# Build and push to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

docker build -t playwright-jsonrpc:latest .
docker tag playwright-jsonrpc:latest <account>.dkr.ecr.us-east-1.amazonaws.com/playwright-jsonrpc:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/playwright-jsonrpc:latest

# Create ECS task definition and service using AWS Console or CLI
```

#### Google Cloud Run

```bash
# Build and deploy to Cloud Run
gcloud builds submit --tag gcr.io/PROJECT_ID/playwright-jsonrpc
gcloud run deploy playwright-jsonrpc \
  --image gcr.io/PROJECT_ID/playwright-jsonrpc \
  --platform managed \
  --region us-central1 \
  --set-env-vars API_KEY=your-api-key,HEADLESS=true \
  --memory 2Gi \
  --cpu 2 \
  --max-instances 10
```

#### Azure Container Instances

```bash
# Push to Azure Container Registry
az acr build --registry myregistry --image playwright-jsonrpc:latest .

# Deploy to ACI
az container create \
  --resource-group myResourceGroup \
  --name playwright-jsonrpc \
  --image myregistry.azurecr.io/playwright-jsonrpc:latest \
  --cpu 2 \
  --memory 2 \
  --ports 3337 \
  --environment-variables \
    API_KEY=your-api-key \
    HEADLESS=true
```

### CI/CD Pipeline

The project includes a comprehensive GitHub Actions workflow (`.github/workflows/ci.yml`) that:

1. **Tests**: Runs unit tests on Node 18.x and 20.x
2. **Security Scanning**: npm audit, Snyk, and Trivy scans
3. **Docker Build**: Builds and tests Docker image
4. **Image Scanning**: Scans Docker image for vulnerabilities
5. **Integration Tests**: Tests with Docker Compose
6. **Push to Registry**: Pushes to GitHub Container Registry on main branch

#### Manual Workflow Trigger

```bash
# Trigger workflow manually
gh workflow run ci.yml
```

#### Using the Published Image

```bash
# Pull from GitHub Container Registry
docker pull ghcr.io/your-org/playwright-jsonrpc:latest

# Run the pulled image
docker run -d -p 3337:3337 \
  -e API_KEY=your-key \
  ghcr.io/your-org/playwright-jsonrpc:latest
```

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3337` | HTTP server port |
| `NODE_ENV` | `development` | Node environment |
| `API_KEY` | - | **Required** API authentication key |
| `ALLOW_HOST_REGEX` | `^https?://...` | Host validation regex |
| `SESSION_TTL_MS` | `120000` | Session timeout (ms) |
| `MAX_CONCURRENT_SESSIONS` | `8` | Max simultaneous sessions |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `120` | Max requests per window |
| `HEADLESS` | `true` | Run browser headless |
| `BROWSER_ARGS` | `--disable-dev-shm-usage,--no-sandbox` | Browser CLI args |
| `LOG_LEVEL` | `info` | Logging level |
| `LOG_FORMAT` | `json` | Log output format |

See `.env.example` for complete list.

### Security Best Practices

#### Production Checklist

- [ ] Use strong, randomly generated API key (32+ characters)
- [ ] Enable TLS/HTTPS for all external access
- [ ] Configure restrictive `ALLOW_HOST_REGEX` pattern
- [ ] Set appropriate rate limits for your use case
- [ ] Use secret management (Vault, AWS Secrets Manager, etc.)
- [ ] Enable monitoring and alerting
- [ ] Configure log aggregation
- [ ] Use specific image tags (not `latest`)
- [ ] Implement network policies in Kubernetes
- [ ] Regular security updates and vulnerability scanning
- [ ] Configure resource limits to prevent DoS
- [ ] Use non-root containers (default)
- [ ] Enable audit logging
- [ ] Implement request tracing
- [ ] Set up backup and disaster recovery

#### Container Security

The Docker image follows security best practices:

- Multi-stage build to minimize attack surface
- Based on official Playwright image with security updates
- Non-root user (pwuser, UID 1001)
- Minimal file system permissions
- No unnecessary packages or dependencies
- Security labels and metadata
- Regular vulnerability scanning in CI/CD

### Monitoring and Observability

#### Health Checks

```bash
# Basic health check
curl http://localhost:3337/health

# Response:
{
  "status": "ok",
  "uptime": 12345.67,
  "sessions": {
    "active": 2,
    "max": 8,
    "oldestAge": 30000
  }
}
```

#### Prometheus Metrics (Optional)

Enable metrics in configuration:
```bash
METRICS_ENABLED=true
METRICS_PORT=9090
```

Access metrics:
```bash
curl http://localhost:9090/metrics
```

#### Logging

Structured JSON logging is enabled by default in production:

```json
{
  "timestamp": "2025-10-08T12:00:00.000Z",
  "level": "info",
  "message": "Session created",
  "sessionId": "s_abc123",
  "metadata": {}
}
```

Configure log level:
```bash
LOG_LEVEL=debug  # debug, info, warn, error
LOG_FORMAT=json  # json, pretty
```

### Performance Tuning

#### Resource Allocation

Recommended resources per container:

**Light workload** (1-2 concurrent sessions):
- CPU: 500m - 1 core
- Memory: 512MB - 1GB

**Medium workload** (4-6 concurrent sessions):
- CPU: 1-2 cores
- Memory: 1-2GB

**Heavy workload** (8+ concurrent sessions):
- CPU: 2-4 cores
- Memory: 2-4GB

#### Browser Optimization

```bash
# Reduce memory usage
BROWSER_ARGS=--disable-dev-shm-usage,--no-sandbox,--disable-gpu

# Limit screenshot sizes
MAX_SCREENSHOT_SIZE_MB=5

# Shorter session TTL
SESSION_TTL_MS=60000
```

#### Connection Pooling

For high throughput, use session reuse:

```javascript
// Create session once
const { session_id } = await createSession();

// Reuse for multiple operations
await navigateTo(session_id, url1);
await navigateTo(session_id, url2);
await navigateTo(session_id, url3);

// Close when done
await closeSession(session_id);
```

### Load Testing

```bash
# Install k6
brew install k6  # or download from k6.io

# Run load test
k6 run test/load/script.js

# Sample k6 script
cat > load-test.js << 'EOF'
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
};

export default function () {
  const res = http.post('http://localhost:3337/rpc',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'session.create',
      params: {}
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'your-api-key'
      }
    }
  );

  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
EOF

k6 run load-test.js
```

## Troubleshooting

### Common Issues

**Session Not Found**
- Session may have expired (check TTL)
- Session was already closed
- Invalid session ID format

**Navigation Timeout**
- Page taking too long to load
- Network issues
- Increase timeout parameter

**Selector Not Found**
- Element doesn't exist
- Element not visible yet
- Selector syntax error

**Rate Limit Exceeded**
- Too many requests in time window
- Implement request queuing/backoff

**Container Won't Start**
- Check API_KEY is set
- Verify port 3337 is available
- Check Docker logs: `docker logs playwright-jsonrpc`
- Ensure sufficient resources allocated

**High Memory Usage**
- Reduce MAX_CONCURRENT_SESSIONS
- Lower SESSION_TTL_MS to cleanup faster
- Check for session leaks (always close sessions)
- Monitor with `/health` endpoint

**Kubernetes Pod CrashLoopBackOff**
- Check secret exists: `kubectl get secret -n playwright-jsonrpc`
- View pod logs: `kubectl logs -n playwright-jsonrpc <pod-name>`
- Check resource limits aren't too low
- Verify image pull permissions

## License

MIT

## Contributing

Contributions are welcome! Please ensure:
- Tests pass (`npm test`)
- Code is formatted (`npm run format`)
- Linting passes (`npm run lint`)
- TypeScript compiles (`npm run typecheck`)
- Docker image builds successfully (`docker build .`)
- Documentation is updated