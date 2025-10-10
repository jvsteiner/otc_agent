# Playwright JSON-RPC Microservice - Diagnostic Report

## Status: NOT RUNNING

### Root Cause
The Playwright JSON-RPC microservice cannot start because the system is **missing required browser dependencies**. Playwright needs specific system libraries to launch Chromium browsers.

---

## Error Details

When attempting to start the microservice, it fails with:

```
Failed to start server: browserType.launch:
╔══════════════════════════════════════════════════════╗
║ Host system is missing dependencies to run browsers. ║
║ Please install them with the following command:      ║
║                                                      ║
║     sudo npx playwright install-deps                 ║
╚══════════════════════════════════════════════════════╝
```

---

## Fix Instructions

### Option 1: Quick Fix (Recommended)
Run the automated installation script:

```bash
cd /home/vrogojin/otc_agent/packages/playwright-jsonrpc
sudo bash install-deps.sh
```

### Option 2: Manual Installation
Install dependencies manually using Playwright's built-in command:

```bash
sudo npx playwright install-deps chromium
```

### Option 3: Minimal Package Installation
Install only the essential packages:

```bash
sudo apt-get update
sudo apt-get install -y libnspr4 libnss3 libgbm1 libasound2
```

---

## After Installing Dependencies

### 1. Start the Microservice

```bash
cd /home/vrogojin/otc_agent/packages/playwright-jsonrpc
npm start
```

The server will start on **port 3337** (not 3000) by default.

### 2. Verify Health Check

```bash
curl http://localhost:3337/health
```

Expected response:
```json
{
  "status": "ok",
  "uptime": <seconds>,
  "sessions": {
    "active": 0,
    "max": 10,
    "oldestAge": null
  }
}
```

### 3. Test Session Creation

```bash
curl -X POST http://localhost:3337/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "session.create",
    "params": {"headless": true},
    "id": 1
  }'
```

Expected response:
```json
{
  "jsonrpc": "2.0",
  "result": "<session-id>",
  "id": 1
}
```

---

## Configuration

### Environment Variables
Create a `.env` file if needed (see `.env.example`):

```bash
# Server Configuration
PORT=3337
HEADLESS=true

# Security (optional)
API_KEY=your-secret-key-here
MAX_SESSIONS=10
SESSION_TTL=300000
```

### Default Settings
- **Port**: 3337 (configurable via PORT env var)
- **Headless**: true (set HEADLESS=false to see browser)
- **Max Sessions**: 10
- **Session TTL**: 300000ms (5 minutes)

---

## Troubleshooting

### Port Already in Use
If port 3337 is already in use:

```bash
# Check what's using the port
lsof -i :3337

# Kill the process
kill -9 <PID>

# Or use a different port
PORT=3338 npm start
```

### Browser Launch Fails
If the browser still fails to launch after installing dependencies:

```bash
# Verify Playwright installation
npx playwright --version

# Reinstall browsers
npx playwright install chromium

# Check browser location
ls -la ~/.cache/ms-playwright/
```

### Permission Issues
If you get permission errors:

```bash
# Make sure user has access
chmod +x node_modules/.bin/playwright

# Check home directory permissions
ls -la ~/.cache/
```

---

## Running in Background

### Using nohup
```bash
cd /home/vrogojin/otc_agent/packages/playwright-jsonrpc
nohup npm start > playwright-jsonrpc.log 2>&1 &
```

### Using PM2 (if installed)
```bash
pm2 start npm --name "playwright-jsonrpc" -- start
pm2 logs playwright-jsonrpc
pm2 restart playwright-jsonrpc
```

### Using systemd (production)
Create `/etc/systemd/system/playwright-jsonrpc.service`:

```ini
[Unit]
Description=Playwright JSON-RPC Microservice
After=network.target

[Service]
Type=simple
User=vrogojin
WorkingDirectory=/home/vrogojin/otc_agent/packages/playwright-jsonrpc
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable playwright-jsonrpc
sudo systemctl start playwright-jsonrpc
sudo systemctl status playwright-jsonrpc
```

---

## Current System State

### Installed Components
- Playwright: v1.56.0 ✅
- Browsers: Chromium 1194 installed ✅
- TypeScript compiled: dist/ directory exists ✅
- Dependencies: Installed at root level ✅

### Missing Components
- System libraries: libnspr4, libnss3, libgbm1, libasound2 ❌

### Required Action
**Install system dependencies using sudo access** (see Fix Instructions above)

---

## Technical Details

### Browser Launch Configuration
The microservice launches Chromium with these args:
- `--no-sandbox`
- `--disable-setuid-sandbox`
- `--disable-dev-shm-usage`
- `--disable-gpu`

These are safe flags for running in containerized or restricted environments.

### Session Management
- Sessions are automatically cleaned up after 5 minutes of inactivity
- Maximum 10 concurrent sessions by default
- Each session has isolated browser context
- Console and network events are buffered per session

---

## Next Steps

1. **Install dependencies** (requires sudo)
2. **Start the service**: `npm start`
3. **Test health endpoint**: `curl http://localhost:3337/health`
4. **Create test session**: See "Test Session Creation" above
5. **Integrate with your application**

For API documentation, see: `API.md`
