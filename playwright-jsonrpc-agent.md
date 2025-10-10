# Playwright JSON‑RPC Text Browser Service — Build Task (for Claude Code)

> **Goal:** Build a headless-browser microservice that executes JavaScript, renders pages internally, and exposes a compact **JSON‑RPC 2.0** API to **observe** (visible text, DOM, console/network issues) and **interact** (navigate/click/type) with web apps. The service enables Claude code subagents to *see* and *debug* JS-heavy pages without human relays.

---

## 1) Deliverables

1. **Runnable service**
   - Node.js **20+** (TypeScript) server using **Playwright (Chromium)**.
   - JSON‑RPC 2.0 over **HTTP** at `/rpc`. (Bonus: WebSocket transport for streaming logs.)
   - One **Browser** (shared), multiple **BrowserContext** sessions.

2. **Tests**
   - Unit tests for request validation & method behavior.
   - Integration tests against a local **fixtures** web app exercising async JS, routing, and XHR failures.
   - E2E examples using `curl` and a minimal client (`client/examples/*.ts`).

3. **Docs**
   - This `README.md` (API, usage, security, limits).
   - **OpenRPC** description (`openrpc.json`) mirroring the RPC surface.

4. **Container**
   - `Dockerfile` (distroless or slim Debian) + `docker-compose.yml` for local dev.

5. **Quality gates**
   - ESLint + Prettier, strict TS config (`"strict": true`).
   - GitHub Actions workflow: build, test, `npx playwright install --with-deps`, integration.

---

## 2) Non‑functional Requirements

- **Reliability:** Browser is long‑lived; contexts recycle on idle TTL (default 2 min).
- **Security:** API key, host allow‑list regex, per‑IP rate limits, and payload size caps.
- **Performance:** ≤ 1s overhead for text extraction after page settles on mid‑range host.
- **Resource safety:** Max **N** concurrent contexts (env‑configurable, default 8).
- **Observability:** Structured logs (JSON), request IDs, metrics (basic Prometheus counters).

---

## 3) Architecture Overview

- **Process:**  
  - `Browser` (singleton) → many `BrowserContext` **sessions** (one tab each)  
  - Session keeps small **buffers** for `console` events and `network` responses.
- **Transport:**  
  - JSON‑RPC 2.0 via HTTP POST to `/rpc` (`{jsonrpc, id, method, params}`).
  - Optional WebSocket: multiplex notifications for console/network.

---

## 4) JSON‑RPC Surface (v1)

> **Design principle:** Keep the protocol stateless from the client’s perspective; return strings/JSON only. Use **selectors**, not remote element handles.

### 4.1 Session

- `session.create({ headless?, viewport?, userAgent?, storageState?, proxy? }) → { session_id }`
- `session.close({ session_id }) → { ok }`

### 4.2 Navigation & Wait

- `page.goto({ session_id, url, waitUntil?='networkidle', timeout?=45000 }) → { url, title }`
- `page.waitFor({ session_id, state: 'load'|'domcontentloaded'|'networkidle'|'idleFor', ms? }) → { state }`
- `page.reload({ session_id, waitUntil?, timeout? }) → { url, title }`

### 4.3 Read

- `page.text({ session_id, selector?='body', maxChars?=90000, normalize?=true }) → { text }`  
  Returns **visible text** (`innerText` fallback to `document.body.innerText`).
- `page.content({ session_id }) → { html }` — post‑JS HTML.
- `page.evaluate({ session_id, expression, arg? }) → { result }` — sandboxed JS expression.

### 4.4 Act

- `page.click({ session_id, selector, button?='left', modifiers?, timeout?=15000 }) → { ok }`
- `page.fill({ session_id, selector, value, timeout?=15000 }) → { ok }`
- `page.press({ session_id, selector, key, timeout?=15000 }) → { ok }`

### 4.5 Debug Signals

- `logs.pull({ session_id }) → { console:[{type,text}], pageErrors:[{message,stack?}] }` *(drains buffer)*
- `network.pull({ session_id, onlyErrors?=true }) → { requests:[{url,status}] }` *(drains buffer)*
- `screenshot({ session_id, fullPage?=false, mime?='image/png' }) → { base64 }`

### 4.6 Accessibility (optional but recommended)

- `find.byRole({ session_id, role, name?, exact? }) → { selector }`
- `axe.run({ session_id, include? }) → { violations:[...] }` *(via `@axe-core/playwright`)*

---

## 5) Protocol Examples

**Create a session**
```json
{"jsonrpc":"2.0","id":1,"method":"session.create","params":{"headless":true}}
```
→
```json
{"jsonrpc":"2.0","id":1,"result":{"session_id":"s_4f93..."}}
```

**Navigate and wait**
```json
{"jsonrpc":"2.0","id":2,"method":"page.goto","params":{"session_id":"s_4f93...","url":"http://localhost:8080","waitUntil":"networkidle"}}
```

**Read visible text**
```json
{"jsonrpc":"2.0","id":3,"method":"page.text","params":{"session_id":"s_4f93...","selector":"main"}}
```

**Interact and capture errors**
```json
{"jsonrpc":"2.0","id":4,"method":"page.click","params":{"session_id":"s_4f93...","selector":"role=button[name='Login']"}}
{"jsonrpc":"2.0","id":5,"method":"logs.pull","params":{"session_id":"s_4f93..."}}
{"jsonrpc":"2.0","id":6,"method":"network.pull","params":{"session_id":"s_4f93...","onlyErrors":true}}
```

---

## 6) Project Layout

```
/playwright-jsonrpc/
  ├─ src/
  │   ├─ server.ts           # Express + JSON-RPC wiring
  │   ├─ rpc.ts              # Method registry & validation
  │   ├─ sessions.ts         # Session map, TTL, buffers
  │   ├─ security.ts         # API key, host allow-list, rate limits
  │   ├─ types.ts            # RPC types
  │   └─ util.ts             # text normalization, error helpers
  ├─ test/
  │   ├─ fixtures/           # Local app with JS router, XHR, errors
  │   ├─ integration.spec.ts
  │   └─ unit.spec.ts
  ├─ client/
  │   └─ examples/           # demo client scripts
  ├─ openrpc.json
  ├─ Dockerfile
  ├─ docker-compose.yml
  ├─ README.md
  ├─ package.json
  └─ tsconfig.json
```

---

## 7) Implementation Sketch (TypeScript)

> This is a compact but production‑oriented starting point. Fill in validation and hardening as noted.

```ts
// src/server.ts
import express from 'express';
import { JSONRPCServer } from 'json-rpc-2.0';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { isAllowedHost, requireApiKey, normalizeText } from './security';

type Sess = { ctx: BrowserContext; page: Page; consoleBuf: any[]; netBuf: any[]; lastUsed: number };
const sessions = new Map<string, Sess>();
let browser: Browser;

async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  }
}

async function newSession(p: any): Promise<string> {
  await ensureBrowser();
  const ctx = await browser.newContext({
    viewport: p.viewport ?? { width: 1280, height: 800 },
    userAgent: p.userAgent,
    storageState: p.storageState,
    ignoreHTTPSErrors: true
  });
  const page = await ctx.newPage();
  const consoleBuf: any[] = [];
  const netBuf: any[] = [];
  page.on('console', m => consoleBuf.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', err => consoleBuf.push({ type: 'pageerror', text: String(err) }));
  page.on('response', r => netBuf.push({ url: r.url(), status: r.status() }));

  const id = 's_' + crypto.randomUUID();
  sessions.set(id, { ctx, page, consoleBuf, netBuf, lastUsed: Date.now() });
  return id;
}

async function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  await s.ctx.close();
  sessions.delete(id);
}

const server = new JSONRPCServer();

// --- Session ---
server.addMethod('session.create', async (p: any) => ({ session_id: await newSession(p) }));
server.addMethod('session.close', async ({ session_id }) => { await closeSession(session_id); return { ok: true }; });

// --- Navigation ---
server.addMethod('page.goto', async ({ session_id, url, waitUntil = 'networkidle', timeout = 45000 }) => {
  const s = sessions.get(session_id)!;
  if (!isAllowedHost(url)) throw new Error('URL not allowed by policy');
  await s.page.goto(url, { waitUntil, timeout });
  s.lastUsed = Date.now();
  return { url: s.page.url(), title: await s.page.title() };
});
server.addMethod('page.reload', async ({ session_id, waitUntil = 'networkidle', timeout = 45000 }) => {
  const s = sessions.get(session_id)!;
  await s.page.reload({ waitUntil, timeout });
  s.lastUsed = Date.now();
  return { url: s.page.url(), title: await s.page.title() };
});
server.addMethod('page.waitFor', async ({ session_id, state, ms }) => {
  const s = sessions.get(session_id)!;
  if (state === 'idleFor') { await s.page.waitForTimeout(ms ?? 1000); return { state }; }
  await s.page.waitForLoadState(state as any);
  s.lastUsed = Date.now();
  return { state };
});

// --- Read ---
server.addMethod('page.text', async ({ session_id, selector = 'body', maxChars = 90000, normalize = true }) => {
  const s = sessions.get(session_id)!;
  const text = await s.page.locator(selector).innerText({ timeout: 15000 }).catch(async () =>
    s.page.evaluate(() => document.body.innerText || '')
  );
  s.lastUsed = Date.now();
  return { text: (normalize ? normalizeText(String(text)) : String(text)).slice(0, maxChars) };
});
server.addMethod('page.content', async ({ session_id }) => {
  const s = sessions.get(session_id)!;
  const html = await s.page.content();
  s.lastUsed = Date.now();
  return { html };
});
server.addMethod('page.evaluate', async ({ session_id, expression, arg }) => {
  const s = sessions.get(session_id)!;
  // Ensure expression returns a JSON-serializable value.
  const result = await s.page.evaluate(new Function('arg', `return (${expression});`) as any, arg);
  s.lastUsed = Date.now();
  return { result };
});

// --- Act ---
server.addMethod('page.click', async ({ session_id, selector, button = 'left', timeout = 15000 }) => {
  const s = sessions.get(session_id)!;
  await s.page.locator(selector).click({ button, timeout });
  s.lastUsed = Date.now();
  return { ok: true };
});
server.addMethod('page.fill', async ({ session_id, selector, value, timeout = 15000 }) => {
  const s = sessions.get(session_id)!;
  await s.page.locator(selector).fill(value, { timeout });
  s.lastUsed = Date.now();
  return { ok: true };
});
server.addMethod('page.press', async ({ session_id, selector, key, timeout = 15000 }) => {
  const s = sessions.get(session_id)!;
  await s.page.locator(selector).press(key, { timeout });
  s.lastUsed = Date.now();
  return { ok: true };
});

// --- Signals ---
server.addMethod('logs.pull', async ({ session_id }) => {
  const s = sessions.get(session_id)!;
  const out = { console: [...s.consoleBuf], pageErrors: s.consoleBuf.filter(x => x.type === 'pageerror') };
  s.consoleBuf.length = 0;
  s.lastUsed = Date.now();
  return out;
});
server.addMethod('network.pull', async ({ session_id, onlyErrors = true }) => {
  const s = sessions.get(session_id)!;
  const filtered = s.netBuf.filter(x => !onlyErrors || x.status >= 400);
  s.netBuf.length = 0;
  s.lastUsed = Date.now();
  return { requests: filtered };
});
server.addMethod('screenshot', async ({ session_id, fullPage = false, mime = 'image/png' }) => {
  const s = sessions.get(session_id)!;
  const buf = await s.page.screenshot({ fullPage, type: mime === 'image/jpeg' ? 'jpeg' : 'png' });
  s.lastUsed = Date.now();
  return { base64: buf.toString('base64') };
});

// --- Express bootstrap ---
const app = express();
app.use(helmet());
app.use(express.json({ limit: '512kb' }));
app.use(rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_MAX ?? 120) }));
app.post('/rpc', requireApiKey, body('*').exists(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid payload' });
  const jsonRPCResponse = await server.receive(req.body);
  if (jsonRPCResponse) res.json(jsonRPCResponse); else res.sendStatus(204);
});

// --- Session janitor ---
const TTL_MS = Number(process.env.SESSION_TTL_MS ?? 120_000);
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > TTL_MS) closeSession(id);
  }
}, 10_000);

const PORT = Number(process.env.PORT ?? 3337);
app.listen(PORT, async () => {
  await ensureBrowser();
  console.log(`Playwright JSON-RPC listening on :${PORT}`);
});
```

```ts
// src/security.ts
import { Request, Response, NextFunction } from 'express';

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.API_KEY;
  if (!expected) return res.status(500).json({ error: 'Server misconfigured' });
  const got = req.get('x-api-key');
  if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const allowRegex = new RegExp(process.env.ALLOW_HOST_REGEX ?? '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/');

export function isAllowedHost(url: string) {
  try { return allowRegex.test(url); } catch { return false; }
}

export function normalizeText(t: string) {
  return t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
```

---

## 8) Setup & Run

**Install**
```bash
npm i -D typescript ts-node @types/node eslint prettier
npm i express json-rpc-2.0 playwright helmet express-rate-limit express-validator
npx playwright install --with-deps
```

**Env**
```bash
export API_KEY="dev-key-123"
export ALLOW_HOST_REGEX="^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?/"
export SESSION_TTL_MS=120000
export RATE_LIMIT_MAX=120
export PORT=3337
```

**Start**
```bash
npx ts-node src/server.ts
```

---

## 9) Docker

```dockerfile
# Dockerfile
FROM mcr.microsoft.com/playwright:v1.47.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV PORT=3337
EXPOSE 3337
CMD ["node","dist/server.js"]
```

Build & run:
```bash
npm run build
docker build -t text-browser .
docker run -e API_KEY=dev-key-123 -p 3337:3337 text-browser
```

---

## 10) Test Fixtures (local demo site)

Create a tiny dev site (served on :8080):

- `/` → links to `/projects`
- `/projects` → loads list via `fetch('/api/projects')`
- `/api/projects` → returns JSON after 800ms (simulate latency)
- `/api/fail` → returns 500 (to test network error capture)

Use this to validate JS execution and text snapshots.

---

## 11) Acceptance Criteria

1. **Renders JS pages:** calling `page.goto(..., waitUntil:'networkidle')` on `/projects` returns **non‑empty** `page.text` containing at least one project name.
2. **Interactivity works:** `page.click` on a “New Project” button reveals an input; `page.fill` updates it; subsequent `page.text` reflects the change.
3. **Signals captured:** `logs.pull` returns at least one console message when the page logs; `network.pull` returns the `/api/fail` 500 entry.
4. **Safety enforced:** Requests with a disallowed host return an error; missing/invalid API key → 401.
5. **Resource hygiene:** A session idle beyond TTL is closed automatically; contexts do not leak.

---

## 12) Example Usage (curl)

```bash
API=http://localhost:3337/rpc
KEY="dev-key-123"

curl -s -H "x-api-key: $KEY" -H "content-type: application/json" $API \
  -d '{"jsonrpc":"2.0","id":1,"method":"session.create","params":{}}'
# => {"result":{"session_id":"s_..."}}

# Replace S with the session_id in subsequent calls
```

```bash
curl -s -H "x-api-key: $KEY" -H "content-type: application/json" $API \
  -d '{"jsonrpc":"2.0","id":2,"method":"page.goto","params":{"session_id":"S","url":"http://localhost:8080","waitUntil":"networkidle"}}'
```

```bash
curl -s -H "x-api-key: $KEY" -H "content-type: application/json" $API \
  -d '{"jsonrpc":"2.0","id":3,"method":"page.text","params":{"session_id":"S","selector":"main"}}' | jq -r .result.text
```

---

## 13) Claude Subagent Contract (how to call this service)

**Call style:** Always send JSON‑RPC with `Content-Type: application/json` and header `x-api-key`.

**Strategy for reasoning:**
1. **Open a session** → navigate → **wait** for `'networkidle'` or a specific selector.
2. **Read** with `page.text` on a focused container (e.g., `main`, `[role="dialog"]`, or targeted `data-testid`).
3. **Act** (`click`, `fill`, `press`) → **wait** again → re‑**read** text.
4. **On failures:** Pull `logs.pull` and `network.pull` to surface errors in your analysis.
5. **Close** session when done.

**Selector policy:** Prefer `role=button[name="..."]` or `[data-testid="..."]`. Avoid brittle CSS (nth‑child). If a selector fails, attempt a role‑based fallback.

**Retry policy:** Up to 2 retries with backoff (200ms, 600ms) per action if timeout occurs.

**Output format for the supervising agent:** Always include:
- `url`, `action_taken`, `text_excerpt` (first 1–2 KB), `console_errors`, `network_errors`, `next_step`.

---

## 14) Minimal Client (Node, optional)

```ts
import fetch from 'node-fetch';

const API = 'http://localhost:3337/rpc';
const KEY = 'dev-key-123';

async function rpc(method: string, params: any) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  return res.json();
}

// Demo
(async () => {
  const { result: { session_id } } = await rpc('session.create', {});
  await rpc('page.goto', { session_id, url: 'http://localhost:8080', waitUntil: 'networkidle' });
  const text = await rpc('page.text', { session_id, selector: 'main' });
  console.log(text.result.text.slice(0, 1000));
  const logs = await rpc('logs.pull', { session_id });
  console.log('console:', logs.result.console);
  await rpc('session.close', { session_id });
})();
```

---

## 15) OpenRPC Skeleton (`openrpc.json`)

```json
{
  "openrpc": "1.2.6",
  "info": { "title": "Playwright Text Browser RPC", "version": "1.0.0" },
  "methods": [
    { "name": "session.create", "params": [], "result": { "name": "result", "schema": { "type": "object", "properties": {"session_id":{"type":"string"}} } } },
    { "name": "session.close", "params": [{"name":"session_id","schema":{"type":"string"}}], "result": { "name": "result", "schema": {"type":"object","properties":{"ok":{"type":"boolean"}}} } },
    { "name": "page.goto", "params": [{"name":"session_id","schema":{"type":"string"}},{"name":"url","schema":{"type":"string"}},{"name":"waitUntil","schema":{"type":"string"}},{"name":"timeout","schema":{"type":"number"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "url":{"type":"string"}, "title":{"type":"string"} } } } },
    { "name": "page.text", "params": [{"name":"session_id","schema":{"type":"string"}},{"name":"selector","schema":{"type":"string"}},{"name":"maxChars","schema":{"type":"number"}},{"name":"normalize","schema":{"type":"boolean"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "text":{"type":"string"} } } } },
    { "name": "page.content", "params": [{"name":"session_id","schema":{"type":"string"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "html":{"type":"string"} } } } },
    { "name": "page.click", "params": [{"name":"session_id","schema":{"type":"string"}},{"name":"selector","schema":{"type":"string"}},{"name":"button","schema":{"type":"string"}},{"name":"timeout","schema":{"type":"number"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "ok":{"type":"boolean"} } } } },
    { "name": "page.fill", "params": [{"name":"session_id","schema":{"type":"string"}},{"name":"selector","schema":{"type":"string"}},{"name":"value","schema":{"type":"string"}},{"name":"timeout","schema":{"type":"number"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "ok":{"type":"boolean"} } } } },
    { "name": "page.press", "params": [{"name":"session_id","schema":{"type":"string"}},{"name":"selector","schema":{"type":"string"}},{"name":"key","schema":{"type":"string"}},{"name":"timeout","schema":{"type":"number"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "ok":{"type":"boolean"} } } } },
    { "name": "logs.pull", "params": [{"name":"session_id","schema":{"type":"string"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "console":{"type":"array","items":{"type":"object"}}, "pageErrors":{"type":"array","items":{"type":"object"}} } } } },
    { "name": "network.pull", "params": [{"name":"session_id","schema":{"type":"string"}},{"name":"onlyErrors","schema":{"type":"boolean"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "requests":{"type":"array","items":{"type":"object"}} } } } },
    { "name": "screenshot", "params": [{"name":"session_id","schema":{"type":"string"}},{"name":"fullPage","schema":{"type":"boolean"}},{"name":"mime","schema":{"type":"string"}}], "result": { "name": "result", "schema": { "type":"object", "properties": { "base64":{"type":"string"} } } } }
  ]
}
```

---

## 16) Task Checklists

### 16.1 Coding
- [ ] Implement methods above with input validation.
- [ ] Enforce API key and host allow‑list.
- [ ] Add TTL janitor and max‑contexts guard.
- [ ] Normalize visible text; clamp response sizes.

### 16.2 Testing
- [ ] Fixture app: routes, delayed XHR, one 500, one console error.
- [ ] Integration: navigate, click, fill, read, pull logs/network.
- [ ] Negative tests: disallowed host, missing API key, bad selector.

### 16.3 Docs
- [ ] README usage sections mirror curl examples.
- [ ] OpenRPC file generated and validated.

---

## 17) “Claude‑ready” System Prompt (drop‑in)

```
You are a code execution agent that can call a JSON‑RPC Playwright service to inspect and interact with real web apps.

Contract:
- Always open a session → navigate → wait for 'networkidle' or a target selector.
- Read with page.text on the narrowest container (main, dialog, or data-testid).
- Prefer role-based selectors (role=button[name="..."]) or [data-testid] when clicking or typing.
- After each action, wait appropriately before reading again.
- On any failure: call logs.pull + network.pull and include findings in your reasoning.
- Provide results in this JSON: {url, action_taken, text_excerpt, console_errors, network_errors, next_step}.
- Close the session on completion.

You must not assume page content; rely only on the service’s returned text or signals.
```

---

## 18) Notes & Future Work

- WebSocket transport to stream logs/network in real time.
- Storage state management API for authenticated flows.
- Role‑based finders and axe integration for accessibility‑aware interactions.
- Har capture & trace-on-failure mode for deep debugging.

---

**That’s the spec.** Build the service, pass the acceptance criteria, and wire your Claude subagents to call it. 
