# Domain Configuration for HTTPS Deployment

## Overview

The OTC Broker Engine now supports domain-based HTTPS deployment with automatic HTTP-to-HTTPS redirect. The domain `unicity-swap.dyndns.org` has been configured for production use.

## Configuration Changes

### 1. Environment Files Updated

#### `.env.production`
Added DOMAIN configuration at line 5-7:
```bash
# Domain Configuration
# Domain name for production deployment (used for HTTPS URLs when SSL is enabled)
DOMAIN=unicity-swap.dyndns.org
```

#### `.env.example`
Added comprehensive DOMAIN documentation at lines 4-11:
```bash
# Domain Configuration (Production Only)
# Set your production domain name here. Used for:
# - HTTPS redirect URLs when SSL is enabled
# - BASE_URL construction when SSL certificates are detected
# - Email link generation in production mode
# Leave empty for development (defaults to localhost)
# Example: DOMAIN=example.com
# DOMAIN=
```

## How It Works

### Server Configuration Flow

The server configuration is automatically determined based on environment variables and SSL certificate availability:

```
┌─────────────────────────────────────────────────────────┐
│ 1. Check for SSL certificates in .ssl/ directory        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 2. Get server config based on SSL + production mode     │
│    - getServerConfig(sslEnabled, productionMode)        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Determine host via getProductionHost():              │
│    Priority order:                                       │
│    a) DOMAIN environment variable (highest)             │
│    b) PUBLIC_IP environment variable                    │
│    c) Auto-detected network interface IP               │
│    d) Fallback to localhost                             │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 4. Construct BASE_URL:                                  │
│    - If SSL: https://unicity-swap.dyndns.org            │
│    - If HTTP: http://unicity-swap.dyndns.org            │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 5. Start servers:                                       │
│    - HTTPS on port 443                                  │
│    - HTTP redirect on port 80 → HTTPS URL              │
└─────────────────────────────────────────────────────────┘
```

### Configuration Scenarios

#### Scenario 1: Production with SSL (RECOMMENDED)
```bash
# .env.production
DOMAIN=unicity-swap.dyndns.org
PRODUCTION_MODE=true

# SSL certificates in .ssl/
# - .ssl/cert.pem
# - .ssl/key.pem
# - .ssl/ca.pem (optional)
```

**Result:**
- Protocol: HTTPS
- Port: 443
- BASE_URL: `https://unicity-swap.dyndns.org`
- HTTP redirect: Port 80 → `https://unicity-swap.dyndns.org`
- All deal links use: `https://unicity-swap.dyndns.org/d/{dealId}/...`

#### Scenario 2: Production without SSL (HTTP only)
```bash
# .env.production
DOMAIN=unicity-swap.dyndns.org
PRODUCTION_MODE=true
# No SSL certificates
```

**Result:**
- Protocol: HTTP
- Port: 80
- BASE_URL: `http://unicity-swap.dyndns.org`
- No redirect server (not needed)

#### Scenario 3: Development Mode
```bash
# .env
PORT=8080
# DOMAIN not set
```

**Result:**
- Protocol: HTTP
- Port: 8080
- BASE_URL: `http://localhost:8080`
- No production restrictions

## Implementation Details

### Key Files

1. **`/home/vrogojin/otc_agent/packages/backend/src/config/server-config.ts`**
   - `getServerConfig()`: Main configuration function (line 57)
   - `getProductionHost()`: Domain resolution logic (line 172)
   - `parseBaseUrl()`: BASE_URL parsing (line 117)
   - Priority: DOMAIN > PUBLIC_IP > Auto-detect > localhost

2. **`/home/vrogojin/otc_agent/packages/backend/src/services/http-redirect.ts`**
   - `HttpRedirectServer`: HTTP-to-HTTPS redirect implementation
   - Preserves path and query strings during redirect
   - Uses 301 (permanent) redirects for SEO and caching
   - Implements HSTS headers for security

3. **`/home/vrogojin/otc_agent/packages/backend/src/index.ts`**
   - Main server initialization (line 32)
   - SSL detection and server startup (lines 176-243)
   - HTTPS server creation with redirect (lines 202-238)
   - HTTP-only fallback (lines 239-243)

### HTTP Redirect Behavior

When SSL is enabled, the HTTP redirect server:

1. **Listens on port 80** for all HTTP requests
2. **Extracts request path** and query parameters
3. **Constructs HTTPS URL** using configured DOMAIN
4. **Sends 301 redirect** with proper headers:
   - `Location`: Full HTTPS URL with path preserved
   - `Strict-Transport-Security`: HSTS header for security
   - `X-Content-Type-Options`: Security hardening

Example redirect flow:
```
HTTP Request:  http://unicity-swap.dyndns.org/d/abc123/a/token456
               ↓
301 Redirect:  Location: https://unicity-swap.dyndns.org/d/abc123/a/token456
               ↓
HTTPS Request: https://unicity-swap.dyndns.org/d/abc123/a/token456
```

## Verification Steps

### 1. Verify Configuration

Run the verification script:
```bash
node verify-domain-config.js
```

Expected output:
```
✅ All checks passed!

Production HTTPS Configuration:
   - HTTPS will run on: https://unicity-swap.dyndns.org:443
   - HTTP redirect: http://unicity-swap.dyndns.org:80 → https://unicity-swap.dyndns.org
```

### 2. Test SSL Certificate Setup

Place SSL certificates in `.ssl/` directory:
```bash
.ssl/
├── cert.pem    # Public certificate
├── key.pem     # Private key
└── ca.pem      # Certificate Authority chain (optional)
```

### 3. Start Production Server

```bash
npm run prod
# or
./run-prod.sh
```

Expected console output:
```
═══════════════════════════════════════════════════════
🌐 Server Configuration
───────────────────────────────────────────────────────
   Mode:         Production
   Protocol:     HTTPS
   SSL Enabled:  Yes ✓
   Host:         unicity-swap.dyndns.org
   Port:         443
   HTTP Redirect: Port 80 → https://unicity-swap.dyndns.org
───────────────────────────────────────────────────────
   BASE_URL:     https://unicity-swap.dyndns.org
───────────────────────────────────────────────────────
   Access:       https://unicity-swap.dyndns.org
                 (HTTP requests will redirect to HTTPS)
═══════════════════════════════════════════════════════

✓ HTTPS server listening on port 443
✓ HTTP redirect server listening on port 80
  Redirecting all HTTP → https://unicity-swap.dyndns.org
```

### 4. Test HTTP Redirect

```bash
# Test that HTTP redirects to HTTPS
curl -I http://unicity-swap.dyndns.org/test/path

# Expected response:
# HTTP/1.1 301 Moved Permanently
# Location: https://unicity-swap.dyndns.org/test/path
# Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### 5. Test HTTPS Access

```bash
# Test HTTPS endpoint
curl https://unicity-swap.dyndns.org/

# Should return the main page without redirect
```

### 6. Verify Deal Links

Create a test deal and verify the URLs in the response:
```bash
curl -X POST https://unicity-swap.dyndns.org/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "otc.createDeal",
    "params": {...},
    "id": 1
  }'
```

All URLs in the response should use `https://unicity-swap.dyndns.org`:
- `alicePersonalUrl`
- `bobPersonalUrl`
- `publicUrl`

## Troubleshooting

### Issue: Port 80 Permission Denied

**Error:**
```
❌ Permission denied to bind to port 80
   Port 80 requires root/administrator privileges
```

**Solutions:**
1. Run with sudo (Linux/Mac):
   ```bash
   sudo npm run prod
   ```

2. Grant CAP_NET_BIND_SERVICE capability (Linux):
   ```bash
   sudo setcap cap_net_bind_service=+ep $(which node)
   npm run prod
   ```

3. Use a reverse proxy (nginx, Apache) on port 80:
   ```nginx
   # nginx config
   server {
       listen 80;
       server_name unicity-swap.dyndns.org;
       return 301 https://$server_name$request_uri;
   }
   ```

### Issue: SSL Certificates Not Found

**Error:**
```
⚠️  No SSL certificates found in .ssl/ directory
   For HTTPS support, add certificates to:
   - .ssl/cert.pem (certificate)
   - .ssl/key.pem (private key)
   - .ssl/ca.pem (optional)
```

**Solution:**
Place SSL certificates in the `.ssl/` directory at project root. The server will automatically detect and load them on next startup.

### Issue: Domain Not Resolving

**Problem:** DOMAIN is set but server still uses IP address

**Solution:** Ensure BASE_URL is not explicitly set in `.env.production`. If BASE_URL is set, it takes precedence over DOMAIN. Remove or comment out BASE_URL to use DOMAIN-based auto-configuration:

```bash
# .env.production
DOMAIN=unicity-swap.dyndns.org
# BASE_URL=http://213.199.61.236  # <- Comment this out
```

### Issue: HTTP Redirect Not Working

**Problem:** HTTP requests are not redirected to HTTPS

**Checklist:**
1. Verify SSL certificates are loaded (check startup logs)
2. Verify HTTP redirect server started successfully
3. Check port 80 is not blocked by firewall
4. Verify DOMAIN environment variable is set
5. Check server logs for redirect activity (set `LOG_LEVEL=debug`)

## Security Considerations

### HSTS (HTTP Strict Transport Security)

The redirect server automatically sends HSTS headers:
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

This instructs browsers to:
- Always use HTTPS for the domain (1 year)
- Apply to all subdomains
- Prevent man-in-the-middle attacks

### SSL/TLS Best Practices

1. **Use strong certificates**: Use certificates from trusted CAs (Let's Encrypt, DigiCert, etc.)
2. **Keep certificates updated**: Monitor expiration dates
3. **Use TLS 1.2+**: Modern Node.js versions enforce this by default
4. **Regular updates**: Keep Node.js and dependencies updated for security patches

## Environment Variable Reference

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DOMAIN` | string | (none) | Production domain name for HTTPS URLs |
| `BASE_URL` | string | auto | Explicit BASE_URL override (discouraged in production) |
| `PUBLIC_IP` | string | (none) | Fallback IP if DOMAIN not set |
| `PRODUCTION_MODE` | boolean | false | Enable production mode and restrictions |
| `PORT` | number | 8080 | HTTP port (dev) or HTTPS port (prod) |
| `LOG_LEVEL` | string | info | Log verbosity (debug, info, warn, error) |

## Summary

✅ **What was done:**
1. Added `DOMAIN=unicity-swap.dyndns.org` to `.env.production`
2. Added comprehensive DOMAIN documentation to `.env.example`
3. Verified `server-config.ts` correctly uses DOMAIN environment variable
4. Confirmed HTTP redirect server uses configured domain for HTTPS URLs
5. Created verification script for testing configuration

✅ **Expected behavior with SSL enabled:**
- HTTPS runs on port 443
- HTTP redirect runs on port 80
- All HTTP requests redirect to `https://unicity-swap.dyndns.org`
- All deal links use `https://unicity-swap.dyndns.org`
- BASE_URL automatically becomes `https://unicity-swap.dyndns.org`

✅ **Files modified:**
- `/home/vrogojin/otc_agent/.env.production` (added DOMAIN)
- `/home/vrogojin/otc_agent/.env.example` (added DOMAIN documentation)

✅ **Files verified (no changes needed):**
- `/home/vrogojin/otc_agent/packages/backend/src/config/server-config.ts`
- `/home/vrogojin/otc_agent/packages/backend/src/services/http-redirect.ts`
- `/home/vrogojin/otc_agent/packages/backend/src/index.ts`

The implementation is complete and ready for production HTTPS deployment! 🎉
