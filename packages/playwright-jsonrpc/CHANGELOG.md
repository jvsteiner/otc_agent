# Changelog

All notable changes to the Playwright JSON-RPC Browser Automation Service will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-10-08

### Initial Release

Production-ready headless browser microservice exposing Playwright automation capabilities through a JSON-RPC 2.0 API.

### Added

#### Core Features
- **JSON-RPC 2.0 API** over HTTP with full specification compliance
- **Session Management** with automatic TTL-based cleanup
- **16 RPC Methods** covering navigation, content extraction, interactions, and debugging
- **Comprehensive Type Safety** with TypeScript throughout

#### Session Management
- `session.create` - Create isolated browser sessions with custom configuration
- `session.close` - Explicit resource cleanup and session termination
- Automatic session expiration after configurable TTL (default 120s)
- Independent cookies, storage, and cache per session
- Support for custom viewport sizes, user agents, and proxy configuration

#### Navigation Methods
- `page.goto` - Navigate to URLs with configurable wait strategies
- `page.reload` - Reload current page
- `page.waitFor` - Wait for specific page states or time delays
- Support for `load`, `domcontentloaded`, `networkidle`, and `commit` wait strategies

#### Content Extraction
- `page.text` - Extract visible text with normalization and truncation
- `page.content` - Get full HTML content
- `page.evaluate` - Execute arbitrary JavaScript in page context
- Configurable text extraction with selector support

#### Page Interactions
- `page.click` - Click elements with modifier keys and multiple click support
- `page.fill` - Fill input fields with proper event triggering
- `page.press` - Press keyboard keys with modifier combinations
- Full support for CSS selectors, XPath, and Playwright locators

#### Debug Signals
- `logs.pull` - Retrieve and drain console logs and page errors
- `network.pull` - Track network requests with error filtering
- `screenshot` - Capture page screenshots in PNG/JPEG format
- Event buffers with automatic cleanup on retrieval

#### Accessibility
- `find.byRole` - Find elements by ARIA role and accessible name
- Support for all standard ARIA roles
- Exact and fuzzy name matching

#### Security Features
- **API Key Authentication** via `x-api-key` header
- **Host Allowlist** with regex-based URL validation
- **Rate Limiting** with configurable window and max requests
- **Session Limits** to prevent resource exhaustion
- **Content Size Limits** for request/response payloads
- **Input Validation** for all parameters

#### Resource Management
- Maximum concurrent session limits
- Automatic TTL-based session cleanup
- Memory-efficient event buffering
- Browser context pooling

#### Deployment Support
- **Docker** with multi-stage builds (production, development, builder)
- **Docker Compose** with profiles for dev, production, and monitoring
- **Kubernetes** manifests with HPA, network policies, and ingress
- **CI/CD** with GitHub Actions workflow
- Health check endpoint at `/health`
- Prometheus-ready metrics support

#### Monitoring & Observability
- Structured JSON logging
- Configurable log levels (debug, info, warn, error)
- Health check endpoint with session statistics
- Request/response logging with timestamps
- Error tracking and reporting

#### Documentation
- Comprehensive README with examples
- Detailed API documentation (API.md)
- OpenRPC 1.2.6 specification with examples and error codes
- Deployment guide (DEPLOYMENT.md)
- Client usage examples (cURL, Node.js, Python)
- Architecture diagrams and flow charts

#### Testing
- Unit tests for utilities and security
- Integration tests for all RPC methods
- Security-focused test suite
- Comprehensive test coverage
- Test fixtures and helpers

#### Developer Experience
- TypeScript with strict type checking
- ESLint configuration for code quality
- Prettier for consistent formatting
- Environment variable validation
- Example .env file with all options

### Configuration

#### Environment Variables
- `PORT` - HTTP server port (default: 3337)
- `API_KEY` - Required API authentication key
- `ALLOW_HOST_REGEX` - URL validation pattern (default: localhost only)
- `SESSION_TTL_MS` - Session timeout (default: 120000ms)
- `MAX_CONCURRENT_SESSIONS` - Session limit (default: 8)
- `RATE_LIMIT_WINDOW_MS` - Rate limit window (default: 60000ms)
- `RATE_LIMIT_MAX` - Max requests per window (default: 120)
- `HEADLESS` - Browser headless mode (default: true)
- `BROWSER_ARGS` - Browser CLI arguments
- `LOG_LEVEL` - Logging level (default: info)
- `LOG_FORMAT` - Log output format (default: json)

### Technical Details

#### Architecture
- Express.js HTTP server
- json-rpc-2.0 library for RPC handling
- Playwright for browser automation
- SQLite not used (stateless service)
- In-memory session storage with Map
- Event-driven architecture

#### Browser Support
- Chromium (primary)
- Firefox (supported)
- WebKit (supported)
- Configurable via Playwright

#### Performance
- Session reuse for multiple operations
- Connection pooling
- Efficient text normalization
- Base64 screenshot encoding
- Event buffer management

### Error Codes

#### Standard JSON-RPC Errors
- `-32700` Parse Error
- `-32600` Invalid Request
- `-32601` Method Not Found
- `-32602` Invalid Params
- `-32603` Internal Error

#### Application-Specific Errors
- `-32001` Session Not Found
- `-32002` URL Not Allowed
- `-32003` Max Sessions Exceeded
- `-32004` Timeout Error
- `-32005` Selector Not Found
- `-32006` Navigation Error

### Dependencies

#### Production
- express ^4.18.2
- json-rpc-2.0 ^1.7.0
- playwright ^1.40.0
- express-rate-limit ^7.1.5
- dotenv ^16.3.1

#### Development
- typescript ^5.3.3
- vitest ^1.0.4
- @playwright/test ^1.40.0
- eslint ^8.56.0
- prettier ^3.1.1

### Breaking Changes
None (initial release)

### Deprecated
None

### Removed
None

### Fixed
None (initial release)

### Security
- API key authentication mandatory
- Host allowlist prevents SSRF attacks
- Rate limiting prevents abuse
- Session limits prevent resource exhaustion
- Input validation prevents injection
- Non-root container user (UID 1001)
- Minimal Docker image surface
- Security scanning in CI/CD

## Known Issues

### Version 1.0.0

#### Limitations
1. **Single Browser Type**: Only Chromium supported by default (Firefox/WebKit require configuration)
2. **In-Memory Sessions**: Sessions lost on server restart
3. **No Session Persistence**: Cannot resume sessions after service restart
4. **Limited File Upload**: File upload not directly supported
5. **No WebSocket Support**: Only HTTP polling for long-running operations

#### Workarounds
1. Configure PLAYWRIGHT_BROWSER environment variable for other browsers
2. Implement client-side session management and retry logic
3. Use external session store if needed (Redis, etc.)
4. Use base64 encoding for file uploads via JavaScript
5. Poll status or use background tasks for long operations

#### Performance Considerations
1. **Memory Usage**: ~100-200MB per session
2. **CPU Usage**: Increases with concurrent sessions
3. **Screenshot Size**: Base64 encoding increases size by ~33%
4. **Network Bandwidth**: Full HTML/screenshots can be large

#### Browser Compatibility
1. **Chromium**: Fully tested and supported
2. **Firefox**: Supported but less tested
3. **WebKit**: Supported but less tested
4. **Safari**: Not available in Docker (WebKit used instead)

### Planned Improvements

#### Version 1.1.0 (Future)
- Session persistence with Redis/PostgreSQL
- WebSocket support for streaming logs
- File upload/download support
- Multi-browser type selection per session
- Enhanced metrics and monitoring
- GraphQL API option
- Client SDKs (Python, Go, Ruby)

#### Version 1.2.0 (Future)
- Session recording and replay
- Video recording support
- HAR (HTTP Archive) export
- Performance metrics (Core Web Vitals)
- Browser DevTools Protocol access
- Custom browser extensions support

#### Version 2.0.0 (Future)
- gRPC API option
- Distributed session management
- Auto-scaling support
- Advanced security features (mTLS, JWT)
- Enhanced rate limiting (per-user, per-IP)
- Cost tracking and billing integration

## Migration Guides

### From Pre-Release to 1.0.0
This is the initial stable release. No migration needed.

## Support

- **Issues**: Report bugs and request features on GitHub
- **Discussions**: Join community discussions
- **Security**: Report security issues privately
- **Documentation**: Refer to README.md and API.md

## License

MIT License - See LICENSE file for details

## Contributors

Thanks to all contributors who helped make this release possible!

---

## Versioning Policy

- **Major version** (X.0.0): Breaking API changes
- **Minor version** (0.X.0): New features, backward compatible
- **Patch version** (0.0.X): Bug fixes, backward compatible

## Release Notes Format

Each release includes:
- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security updates
