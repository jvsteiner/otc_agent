# Playwright JSON-RPC Test Suite

Comprehensive test suite for the Playwright JSON-RPC browser automation microservice.

## Table of Contents

- [Overview](#overview)
- [Test Structure](#test-structure)
- [Running Tests](#running-tests)
- [Test Fixtures](#test-fixtures)
- [Integration Tests](#integration-tests)
- [Unit Tests](#unit-tests)
- [Example Clients](#example-clients)
- [Coverage](#coverage)

## Overview

This test suite provides comprehensive testing coverage for the Playwright JSON-RPC service, including:

- **Unit Tests**: Test individual functions and modules in isolation
- **Integration Tests**: Test complete RPC workflows and service integration
- **Security Tests**: Validate authentication, authorization, and input validation
- **Fixtures**: Interactive HTML pages and mock API endpoints for testing
- **Example Clients**: Demonstration scripts showing real-world usage patterns

## Test Structure

```
test/
├── fixtures/                    # Test fixtures and mock servers
│   ├── server.ts               # Express server with mock API endpoints
│   ├── interactive.html        # Interactive test page with all scenarios
│   └── index.html              # Simple static test page
├── integration/                 # Integration tests
│   ├── basic.spec.ts           # Basic integration tests
│   ├── comprehensive.spec.ts   # Comprehensive RPC method tests
│   └── security.spec.ts        # Security and authentication tests
└── unit/                        # Unit tests
    ├── util.spec.ts            # Utility function tests
    └── security.spec.ts        # Security function tests
```

## Running Tests

### All Tests

```bash
npm test
```

### Watch Mode

```bash
npm run test:watch
```

### Coverage Report

```bash
npm run test:coverage
```

### Specific Test Files

```bash
# Run only integration tests
npm test -- integration

# Run only unit tests
npm test -- unit

# Run specific test file
npm test -- comprehensive.spec.ts
```

### Run Tests with Vitest UI

```bash
npx vitest --ui
```

## Test Fixtures

### Interactive Test Fixture Server

The fixture server (`test/fixtures/server.ts`) provides:

**Mock API Endpoints:**
- `GET /api/projects` - Returns project list with simulated delay
- `GET /api/projects/:id` - Returns single project
- `POST /api/projects` - Create new project
- `GET /api/fail` - Returns 500 error for testing error handling
- `GET /api/slow?delay=ms` - Simulates slow responses
- `GET /api/status/:code` - Returns specific HTTP status codes
- `POST /api/form-submit` - Form submission endpoint

**Starting the Fixture Server:**

```typescript
import { FixtureServer } from './fixtures/server';

const server = new FixtureServer(3400);
await server.start();
// ... run tests ...
await server.stop();
```

### Interactive HTML Page

The interactive test page (`test/fixtures/interactive.html`) includes:

- **Navigation**: Multiple pages with client-side routing
- **Forms**: Input fields, textareas, selects, checkboxes
- **Async Operations**: Delayed content loading, progressive updates
- **API Calls**: Fetch requests to mock endpoints
- **Console Logging**: Various console methods (log, warn, error)
- **Error Scenarios**: Intentional exceptions and errors
- **Network Requests**: XHR, Fetch, parallel requests

Access at: `http://localhost:3400/` when fixture server is running

## Integration Tests

### Basic Integration Tests (`basic.spec.ts`)

Tests core functionality:
- Session creation and closure
- Page navigation
- Content extraction
- Form interactions
- Console log capture
- Network monitoring
- Screenshots

### Comprehensive Tests (`comprehensive.spec.ts`)

Extensive testing of all RPC methods:

**Session Management:**
- Creating sessions with various options
- Multiple concurrent sessions
- Session closure and cleanup
- Operations on invalid/closed sessions

**Navigation Methods:**
- `page.goto` with different waitUntil options
- `page.reload`
- `page.waitFor` with various states
- Timeout handling

**Content Extraction:**
- `page.text` with selectors and normalization
- `page.content` for full HTML
- `page.evaluate` for JavaScript execution

**Page Interactions:**
- `page.click` with different options
- `page.fill` for form inputs
- `page.press` for keyboard events
- Element selection and waiting

**Debug Signals:**
- Console log capture and drainage
- Network event monitoring
- Screenshot capture (viewport and full page)

**Async Operations:**
- Delayed content loading
- Progressive rendering
- Dynamic data fetching

### Security Tests (`security.spec.ts`)

Validates security mechanisms:

**API Key Authentication:**
- Valid key acceptance
- Invalid key rejection
- Missing key handling
- Empty key rejection
- Case-sensitive header validation

**Host Allowlist:**
- Localhost/127.0.0.1 allowance
- External URL blocking
- Custom regex patterns
- Path and query parameter handling

**Session Limits:**
- Maximum concurrent session enforcement
- Session creation after closure
- Limit boundary testing

**JSON-RPC Validation:**
- Request structure validation
- Version checking
- Method presence
- Parameter validation

**HTTP Security:**
- Security headers
- Method restrictions (POST only)
- CORS handling

## Unit Tests

### Utility Functions (`util.spec.ts`)

Tests pure functions:
- `normalizeText()` - Text normalization
- `truncateText()` - Text truncation
- `validateSessionId()` - Session ID validation
- `validateUrl()` - URL validation
- `validateSelector()` - CSS selector validation
- `errorToString()` - Error message conversion
- `generateSessionId()` - UUID generation
- `clamp()` - Number clamping
- `timeout()` - Timeout promise
- `isPlainObject()` - Object type checking
- Error code constants
- Error response creation

### Security Functions (`security.spec.ts`)

Tests security utilities:
- `isAllowedHost()` - URL allowlist checking
- `validateAllowedHost()` - Allowlist validation with errors
- `sanitizeInput()` - Input sanitization
- `validateContentLength()` - Content size validation
- `getSecurityConfig()` - Configuration loading
- `requireApiKey()` - API key middleware
- `validateJsonRpcRequest()` - Request validation middleware

## Example Clients

Located in `client/examples/`:

### Basic Usage (`basic-usage.ts`)

Simple client demonstrating:
- Session creation
- Page navigation
- Text extraction
- Form filling
- Log and network capture
- Screenshot capture

**Run:**
```bash
npx ts-node client/examples/basic-usage.ts
```

### Error Handling (`error-handling.ts`)

Demonstrates robust error handling:
- Connection testing
- Authentication error handling
- Parameter validation errors
- Session management errors
- Timeout handling
- Network error recovery
- Retry logic with backoff
- Graceful degradation

**Features:**
- `ResilientRPCClient` class with automatic retries
- Comprehensive error categorization
- Safe session management
- Fallback strategies

**Run:**
```bash
npx ts-node client/examples/error-handling.ts
```

### OTC Broker Testing (`otc-broker-testing.ts`)

Real-world example for testing OTC broker party pages:
- Party page navigation (Alice/Bob)
- Deal information extraction
- Deposit address verification
- Status monitoring
- Console error detection
- Network error tracking
- Automated screenshot capture
- Continuous monitoring mode

**Usage:**
```bash
# Single test
npx ts-node client/examples/otc-broker-testing.ts <dealId> <token> alice test

# Continuous monitoring
npx ts-node client/examples/otc-broker-testing.ts <dealId> <token> alice monitor
```

**Features:**
- `OTCTestingClient` with specialized methods
- Deal status extraction
- Error and warning detection
- Screenshot documentation
- Real-time monitoring

## Coverage

### Running Coverage Reports

```bash
npm run test:coverage
```

This generates:
- **Text summary** in terminal
- **HTML report** in `coverage/` directory
- **JSON report** for CI/CD integration

### Coverage Targets

The test suite aims for:
- **Line Coverage**: >90%
- **Branch Coverage**: >85%
- **Function Coverage**: >95%
- **Statement Coverage**: >90%

### Viewing HTML Report

```bash
npm run test:coverage
open coverage/index.html
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npx playwright install --with-deps
      - run: npm test
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

## Best Practices

### Writing New Tests

1. **Use descriptive test names** that explain what is being tested
2. **Follow AAA pattern**: Arrange, Act, Assert
3. **Clean up resources** in `afterEach` hooks
4. **Use fixtures** for common setup
5. **Test both success and failure paths**
6. **Avoid test interdependencies**
7. **Use meaningful assertions** with clear error messages

### Test Organization

```typescript
describe('Feature Name', () => {
  let sessionId: string;

  beforeEach(async () => {
    // Setup
    sessionId = await client.createSession();
  });

  afterEach(async () => {
    // Cleanup
    await client.closeSession(sessionId);
  });

  it('should handle specific scenario', async () => {
    // Arrange
    const input = 'test data';

    // Act
    const result = await client.doSomething(sessionId, input);

    // Assert
    expect(result).toBeDefined();
    expect(result.value).toBe('expected');
  });
});
```

## Troubleshooting

### Tests Timing Out

If tests timeout:
1. Increase timeout in `vitest.config.ts`
2. Check if service is running
3. Verify network connectivity
4. Look for deadlocks in browser automation

### Port Already in Use

If fixture server port is in use:
1. Change `FIXTURE_PORT` in test files
2. Kill existing process: `lsof -ti:3400 | xargs kill`

### Playwright Installation

If Playwright browsers are missing:
```bash
npx playwright install --with-deps
```

### Debugging Tests

Run with verbose logging:
```bash
LOG_LEVEL=debug npm test
```

Run single test in watch mode:
```bash
npx vitest comprehensive.spec.ts
```

## Contributing

When adding new tests:
1. Follow existing patterns
2. Update this README if adding new categories
3. Ensure tests pass locally
4. Maintain >90% coverage
5. Document complex test scenarios

## License

MIT
