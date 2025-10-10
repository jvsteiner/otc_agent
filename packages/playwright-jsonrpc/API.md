# Playwright JSON-RPC API Documentation

Complete API reference for the Playwright JSON-RPC Browser Automation Service.

## Table of Contents

- [Authentication](#authentication)
- [Request/Response Format](#requestresponse-format)
- [Error Codes](#error-codes)
- [Session Management](#session-management)
- [Navigation Methods](#navigation-methods)
- [Content Extraction](#content-extraction)
- [Page Interactions](#page-interactions)
- [Debug Signals](#debug-signals)
- [Accessibility](#accessibility)
- [Common Patterns](#common-patterns)
- [Best Practices](#best-practices)

## Authentication

All API requests require authentication using an API key in the request header:

```bash
x-api-key: your-api-key-here
```

Set your API key in the environment:
```bash
export API_KEY="your-secure-api-key"
```

## Request/Response Format

All requests follow JSON-RPC 2.0 specification:

### Request Structure
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "method.name",
  "params": {
    "param1": "value1"
  }
}
```

### Success Response
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "key": "value"
  }
}
```

### Error Response
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Session not found",
    "data": {}
  }
}
```

## Error Codes

### Standard JSON-RPC Errors

| Code | Name | Description |
|------|------|-------------|
| -32700 | Parse Error | Invalid JSON received |
| -32600 | Invalid Request | Invalid JSON-RPC request |
| -32601 | Method Not Found | Method doesn't exist |
| -32602 | Invalid Params | Invalid method parameters |
| -32603 | Internal Error | Internal JSON-RPC error |

### Application-Specific Errors

| Code | Name | Description | Common Causes |
|------|------|-------------|---------------|
| -32001 | Session Not Found | Session doesn't exist or expired | Invalid session ID, session expired (TTL), session already closed |
| -32002 | URL Not Allowed | URL blocked by host policy | URL doesn't match ALLOW_HOST_REGEX pattern |
| -32003 | Max Sessions Exceeded | Too many concurrent sessions | Reached MAX_CONCURRENT_SESSIONS limit |
| -32004 | Timeout Error | Operation timed out | Page load too slow, increase timeout parameter |
| -32005 | Selector Not Found | Element not found | Element doesn't exist, not visible, or incorrect selector |
| -32006 | Navigation Error | Page navigation failed | Network error, DNS failure, invalid URL |

## Session Management

### session.create

Creates a new isolated browser session with its own context.

**Parameters:**
- `headless` (boolean, optional): Run browser in headless mode. Default: `true`
- `viewport` (object, optional): Viewport dimensions
  - `width` (integer): Width in pixels. Default: `1280`
  - `height` (integer): Height in pixels. Default: `800`
- `userAgent` (string, optional): Custom user agent
- `proxy` (object, optional): Proxy configuration
  - `server` (string, required): Proxy URL
  - `username` (string, optional): Proxy auth username
  - `password` (string, optional): Proxy auth password

**Returns:**
- `session_id` (string): Unique session identifier

**Examples:**

Create default session:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.create",
  "params": {}
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000"
  }
}
```

Create mobile session:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.create",
  "params": {
    "headless": true,
    "viewport": {
      "width": 375,
      "height": 667
    },
    "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15"
  }
}
```

Create session with proxy:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.create",
  "params": {
    "proxy": {
      "server": "http://proxy.example.com:8080",
      "username": "user",
      "password": "pass"
    }
  }
}
```

**Notes:**
- Sessions automatically expire after SESSION_TTL_MS (default 120 seconds)
- Each session has independent cookies, storage, and cache
- Always close sessions explicitly to free resources

---

### session.close

Closes a browser session and releases all resources.

**Parameters:**
- `session_id` (string, required): Session ID to close

**Returns:**
- `ok` (boolean): Always `true` on success

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.close",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "ok": true
  }
}
```

## Navigation Methods

### page.goto

Navigates to a URL and waits for page load.

**Parameters:**
- `session_id` (string, required): Session ID
- `url` (string, required): URL to navigate to
- `waitUntil` (string, optional): Wait strategy. Default: `"networkidle"`
  - `"load"`: Wait for load event
  - `"domcontentloaded"`: Wait for DOMContentLoaded event
  - `"networkidle"`: Wait for network to be idle
  - `"commit"`: Wait for navigation to commit
- `timeout` (integer, optional): Timeout in milliseconds. Default: `45000`

**Returns:**
- `url` (string): Current page URL (may differ due to redirects)
- `title` (string): Page title

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "page.goto",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "url": "http://localhost:8080",
    "waitUntil": "networkidle",
    "timeout": 45000
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "url": "http://localhost:8080/",
    "title": "My Application"
  }
}
```

**Notes:**
- URL must match ALLOW_HOST_REGEX pattern (default: localhost only)
- Use `"networkidle"` for SPAs that load data after initial render
- Use `"load"` for static pages to navigate faster

---

### page.reload

Reloads the current page.

**Parameters:**
- `session_id` (string, required): Session ID
- `waitUntil` (string, optional): Wait strategy. Default: `"networkidle"`
- `timeout` (integer, optional): Timeout in milliseconds. Default: `45000`

**Returns:**
- `url` (string): Current page URL
- `title` (string): Page title

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "page.reload",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "waitUntil": "load"
  }
}
```

---

### page.waitFor

Waits for a specific page state.

**Parameters:**
- `session_id` (string, required): Session ID
- `state` (string, required): State to wait for
  - `"load"`: Wait for load event
  - `"domcontentloaded"`: Wait for DOMContentLoaded
  - `"networkidle"`: Wait for network idle
  - `"idleFor"`: Wait for specified milliseconds
- `ms` (integer, optional): Milliseconds to wait (only for `"idleFor"`). Default: `1000`

**Returns:**
- `state` (string): The state that was waited for

**Examples:**

Wait for network idle:
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "page.waitFor",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "state": "networkidle"
  }
}
```

Wait for 2 seconds:
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "page.waitFor",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "state": "idleFor",
    "ms": 2000
  }
}
```

## Content Extraction

### page.text

Extracts visible text from the page.

**Parameters:**
- `session_id` (string, required): Session ID
- `selector` (string, optional): CSS selector. Default: `"body"`
- `maxChars` (integer, optional): Maximum characters. Default: `90000`
- `normalize` (boolean, optional): Normalize whitespace. Default: `true`

**Returns:**
- `text` (string): Extracted visible text

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "page.text",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": "main",
    "maxChars": 90000,
    "normalize": true
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "text": "Welcome to My Application\nThis is the main content..."
  }
}
```

**Notes:**
- Returns `innerText` which respects CSS visibility
- Normalization removes extra whitespace and collapses newlines
- Text is truncated if exceeds `maxChars`

---

### page.content

Gets the full HTML content of the page.

**Parameters:**
- `session_id` (string, required): Session ID

**Returns:**
- `html` (string): Full HTML content

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "page.content",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "html": "<!DOCTYPE html><html><head>...</head><body>...</body></html>"
  }
}
```

---

### page.evaluate

Executes JavaScript code in the page context.

**Parameters:**
- `session_id` (string, required): Session ID
- `expression` (string, required): JavaScript expression or function body
- `arg` (any, optional): Argument to pass to the expression

**Returns:**
- `result` (any): Return value from the expression

**Examples:**

Get page title:
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "page.evaluate",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "expression": "document.title"
  }
}
```

Get computed style:
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "page.evaluate",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "expression": "selector => window.getComputedStyle(document.querySelector(selector)).color",
    "arg": ".header"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "result": "rgb(0, 0, 0)"
  }
}
```

**Security Note:** Only execute trusted JavaScript. Malicious code can access page data and DOM.

## Page Interactions

### page.click

Clicks an element on the page.

**Parameters:**
- `session_id` (string, required): Session ID
- `selector` (string, required): Element selector
- `button` (string, optional): Mouse button. Default: `"left"`
  - `"left"`, `"right"`, `"middle"`
- `modifiers` (array, optional): Keyboard modifiers
  - `["Alt"]`, `["Control"]`, `["Meta"]`, `["Shift"]`
- `timeout` (integer, optional): Timeout in milliseconds. Default: `15000`
- `clickCount` (integer, optional): Number of clicks. Default: `1`

**Returns:**
- `ok` (boolean): Always `true` on success

**Examples:**

Simple click:
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "page.click",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": "button[type='submit']"
  }
}
```

Right-click with Ctrl:
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "page.click",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": ".context-menu-trigger",
    "button": "right",
    "modifiers": ["Control"]
  }
}
```

Double-click:
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "page.click",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": ".item",
    "clickCount": 2
  }
}
```

---

### page.fill

Fills an input field with text.

**Parameters:**
- `session_id` (string, required): Session ID
- `selector` (string, required): Input element selector
- `value` (string, required): Value to fill
- `timeout` (integer, optional): Timeout in milliseconds. Default: `15000`

**Returns:**
- `ok` (boolean): Always `true` on success

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "page.fill",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": "input[name='username']",
    "value": "testuser"
  }
}
```

**Notes:**
- Clears existing value before filling
- Works with `<input>`, `<textarea>`, and `contenteditable` elements
- Triggers input events as if user typed

---

### page.press

Presses a keyboard key on an element.

**Parameters:**
- `session_id` (string, required): Session ID
- `selector` (string, required): Element selector
- `key` (string, required): Key to press (e.g., `"Enter"`, `"Tab"`, `"ArrowDown"`)
- `timeout` (integer, optional): Timeout in milliseconds. Default: `15000`

**Returns:**
- `ok` (boolean): Always `true` on success

**Examples:**

Press Enter:
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "page.press",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": "input[name='search']",
    "key": "Enter"
  }
}
```

Press Ctrl+A (select all):
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "page.press",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": "textarea",
    "key": "Control+A"
  }
}
```

Common keys: `"Enter"`, `"Escape"`, `"Tab"`, `"Backspace"`, `"Delete"`, `"ArrowUp"`, `"ArrowDown"`, `"ArrowLeft"`, `"ArrowRight"`, `"Home"`, `"End"`, `"PageUp"`, `"PageDown"`

## Debug Signals

### logs.pull

Retrieves and clears console logs and page errors.

**Parameters:**
- `session_id` (string, required): Session ID

**Returns:**
- `console` (array): All console events
  - `type` (string): Event type (`"log"`, `"warn"`, `"error"`, `"pageerror"`)
  - `text` (string): Message text
  - `stack` (string, optional): Stack trace for page errors
- `pageErrors` (array): Filtered page errors only

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "logs.pull",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "result": {
    "console": [
      {
        "type": "log",
        "text": "Application started"
      },
      {
        "type": "error",
        "text": "TypeError: Cannot read property 'x' of undefined",
        "stack": "    at Object.doSomething (app.js:42:5)..."
      }
    ],
    "pageErrors": [
      {
        "type": "pageerror",
        "text": "TypeError: Cannot read property 'x' of undefined",
        "stack": "    at Object.doSomething (app.js:42:5)..."
      }
    ]
  }
}
```

**Notes:**
- Buffer is cleared after each pull
- Use for debugging JavaScript errors
- Events are captured from the moment session is created

---

### network.pull

Retrieves and clears network request events.

**Parameters:**
- `session_id` (string, required): Session ID
- `onlyErrors` (boolean, optional): Return only failed requests. Default: `true`

**Returns:**
- `requests` (array): Network events
  - `url` (string): Request URL
  - `status` (integer): HTTP status code (0 for failures)
  - `method` (string): HTTP method
  - `timestamp` (integer): Unix timestamp in milliseconds

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "network.pull",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "onlyErrors": true
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "result": {
    "requests": [
      {
        "url": "https://api.example.com/data",
        "status": 404,
        "method": "GET",
        "timestamp": 1696838400000
      },
      {
        "url": "https://cdn.example.com/script.js",
        "status": 0,
        "method": "GET",
        "timestamp": 1696838401000
      }
    ]
  }
}
```

**Notes:**
- Status `0` indicates network failure (CORS, DNS, timeout)
- Status `>= 400` are HTTP errors
- Buffer is cleared after each pull

---

### screenshot

Captures a screenshot of the page.

**Parameters:**
- `session_id` (string, required): Session ID
- `fullPage` (boolean, optional): Capture full scrollable page. Default: `false`
- `mime` (string, optional): Image format. Default: `"image/png"`
  - `"image/png"`, `"image/jpeg"`

**Returns:**
- `base64` (string): Base64-encoded image data

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "method": "screenshot",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "fullPage": false,
    "mime": "image/png"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "result": {
    "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  }
}
```

**Usage:**

Save to file (bash):
```bash
echo "$BASE64" | base64 -d > screenshot.png
```

Display in HTML:
```html
<img src="data:image/png;base64,iVBORw0KGg..." />
```

## Accessibility

### find.byRole

Finds an element by ARIA role and accessible name.

**Parameters:**
- `session_id` (string, required): Session ID
- `role` (string, required): ARIA role (e.g., `"button"`, `"link"`, `"heading"`)
- `name` (string, optional): Accessible name
- `exact` (boolean, optional): Exact name match. Default: `false`

**Returns:**
- `selector` (string): Playwright role selector

**Examples:**

Find button by role:
```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "find.byRole",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "role": "button",
    "name": "Submit"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "result": {
    "selector": "role=button[name=\"Submit\"]"
  }
}
```

Use the selector with other methods:
```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "method": "page.click",
  "params": {
    "session_id": "s_123e4567-e89b-12d3-a456-426614174000",
    "selector": "role=button[name=\"Submit\"]"
  }
}
```

Common roles: `"button"`, `"link"`, `"textbox"`, `"heading"`, `"list"`, `"listitem"`, `"checkbox"`, `"radio"`, `"tab"`, `"tabpanel"`, `"dialog"`, `"alert"`

## Common Patterns

### Complete Workflow Example

```json
// 1. Create session
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.create",
  "params": {}
}

// 2. Navigate to page
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "page.goto",
  "params": {
    "session_id": "s_abc123",
    "url": "http://localhost:8080"
  }
}

// 3. Fill form
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "page.fill",
  "params": {
    "session_id": "s_abc123",
    "selector": "input[name='username']",
    "value": "testuser"
  }
}

// 4. Submit form
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "page.click",
  "params": {
    "session_id": "s_abc123",
    "selector": "button[type='submit']"
  }
}

// 5. Wait for response
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "page.waitFor",
  "params": {
    "session_id": "s_abc123",
    "state": "networkidle"
  }
}

// 6. Get result text
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "page.text",
  "params": {
    "session_id": "s_abc123",
    "selector": ".result"
  }
}

// 7. Close session
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session.close",
  "params": {
    "session_id": "s_abc123"
  }
}
```

### Error Handling

Always handle errors in your client:

```javascript
async function safeRPC(method, params) {
  const response = await fetch(API_URL, {
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

  const data = await response.json();

  if (data.error) {
    throw new Error(`RPC Error ${data.error.code}: ${data.error.message}`);
  }

  return data.result;
}
```

### Session Reuse

Reuse sessions for better performance:

```javascript
// Create session once
const { session_id } = await rpc('session.create', {});

try {
  // Perform multiple operations
  await rpc('page.goto', { session_id, url: 'http://localhost:8080/page1' });
  const text1 = await rpc('page.text', { session_id });

  await rpc('page.goto', { session_id, url: 'http://localhost:8080/page2' });
  const text2 = await rpc('page.text', { session_id });

  await rpc('page.goto', { session_id, url: 'http://localhost:8080/page3' });
  const text3 = await rpc('page.text', { session_id });
} finally {
  // Always close in finally block
  await rpc('session.close', { session_id });
}
```

## Best Practices

### Performance

1. **Reuse sessions**: Create once, use multiple times
2. **Use appropriate wait strategies**:
   - `"load"` for static pages (fastest)
   - `"domcontentloaded"` for basic interactivity
   - `"networkidle"` for SPAs and dynamic content (slowest)
3. **Specific selectors**: More specific = faster element location
4. **Batch operations**: Minimize round trips to server
5. **Close sessions**: Always close when done to free resources

### Reliability

1. **Handle timeouts**: Set appropriate timeout values
2. **Wait for page state**: Use `page.waitFor` before interactions
3. **Check for errors**: Pull logs/network errors for debugging
4. **Retry logic**: Implement retries for transient failures
5. **Session validation**: Check session exists before operations

### Security

1. **Secure API keys**: Use environment variables, never commit
2. **Host allowlist**: Configure ALLOW_HOST_REGEX to restrict URLs
3. **Rate limiting**: Implement client-side rate limiting
4. **Validate inputs**: Sanitize user-provided selectors and URLs
5. **Trusted JavaScript**: Only evaluate trusted code with `page.evaluate`

### Debugging

1. **Pull console logs**: Check for JavaScript errors
2. **Monitor network**: Identify failed requests
3. **Take screenshots**: Visual debugging when issues occur
4. **Use visible mode**: Set `headless: false` during development
5. **Increase timeouts**: Rule out timing issues

### Selector Strategies

Use this priority order:

1. **Accessibility selectors**: `role=button[name="Submit"]`
2. **Test IDs**: `[data-testid="submit-button"]`
3. **IDs**: `#submit-button`
4. **CSS classes**: `.submit-button` (if stable)
5. **Text content**: `text=Submit`
6. **XPath**: `//button[contains(text(), 'Submit')]` (last resort)

### Resource Management

1. **Monitor active sessions**: Check `/health` endpoint
2. **Set appropriate TTL**: Balance between reuse and resource usage
3. **Limit concurrent sessions**: Prevent resource exhaustion
4. **Use connection pooling**: Reuse HTTP connections
5. **Implement circuit breakers**: Prevent cascade failures

## Additional Resources

- [OpenAPI Specification](/home/vrogojin/otc_agent/packages/playwright-jsonrpc/openrpc.json)
- [Deployment Guide](/home/vrogojin/otc_agent/packages/playwright-jsonrpc/DEPLOYMENT.md)
- [README](/home/vrogojin/otc_agent/packages/playwright-jsonrpc/README.md)
- [Playwright Documentation](https://playwright.dev/)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
