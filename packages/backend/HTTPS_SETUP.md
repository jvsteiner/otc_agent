# HTTPS Setup Guide

This document explains how to configure HTTPS for the OTC Broker Engine backend.

## Overview

The backend automatically detects SSL certificates and configures itself accordingly:

- **With SSL certificates**: Runs HTTPS on port 443 + HTTP redirect on port 80
- **Without SSL certificates**: Runs HTTP on configured port (80 in production, 8080 in development)

## Quick Start

### 1. Create SSL Directory

Create a `.ssl` directory in the project root:

```bash
mkdir -p .ssl
```

### 2. Add SSL Certificates

Place your SSL certificate files in the `.ssl` directory. The system supports multiple naming conventions:

**Certificate files** (one of):
- `cert.pem`
- `certificate.pem`
- `server.crt`
- `server.cert`
- `fullchain.pem` (Let's Encrypt)
- `cert.crt`
- `certificate.crt`

**Private key files** (one of):
- `key.pem`
- `private.pem`
- `privatekey.pem`
- `server.key`
- `privkey.pem` (Let's Encrypt)
- `private.key`

**Certificate Authority chain** (optional):
- `chain.pem` (Let's Encrypt)
- `ca-bundle.pem`
- `ca.pem`
- `ca-bundle.crt`

### 3. Start the Server

```bash
npm run build
npm start
```

The server will automatically:
- Detect SSL certificates
- Start HTTPS on port 443
- Start HTTP redirect server on port 80 (redirects all traffic to HTTPS)
- Configure `BASE_URL` to use `https://`

## URL Configuration

The system automatically determines the correct `BASE_URL` based on environment and SSL availability.

### Configuration Priority (highest to lowest)

1. **Explicit `BASE_URL` environment variable**
   ```bash
   BASE_URL=https://example.com
   ```

2. **SSL-based auto-detection**
   - With SSL: `https://[domain]:443`
   - Without SSL (production): `http://[domain]:80`
   - Without SSL (dev): `http://localhost:8080`

3. **Domain configuration**
   ```bash
   # Set your domain for production
   DOMAIN=example.com

   # Or use IP address
   PUBLIC_IP=203.0.113.10
   ```

### Examples

#### Development (no SSL)
```bash
# Runs on http://localhost:8080
npm run dev
```

#### Production with SSL
```bash
# Create SSL directory and add certificates
mkdir -p .ssl
cp /path/to/fullchain.pem .ssl/
cp /path/to/privkey.pem .ssl/

# Set domain
echo "DOMAIN=example.com" >> .env
echo "PRODUCTION_MODE=true" >> .env

# Start server
npm start
# Runs on https://example.com:443 with HTTP redirect on port 80
```

#### Production without SSL
```bash
# Set domain and production mode
echo "DOMAIN=example.com" >> .env
echo "PRODUCTION_MODE=true" >> .env

# Start server (no .ssl directory)
npm start
# Runs on http://example.com:80
```

## Obtaining SSL Certificates

### Option 1: Let's Encrypt (Free, Recommended)

Using Certbot:

```bash
# Install certbot
sudo apt-get install certbot  # Ubuntu/Debian
# or
brew install certbot          # macOS

# Generate certificate
sudo certbot certonly --standalone -d example.com

# Certificates will be in /etc/letsencrypt/live/example.com/
# Copy to project:
sudo cp /etc/letsencrypt/live/example.com/fullchain.pem .ssl/cert.pem
sudo cp /etc/letsencrypt/live/example.com/privkey.pem .ssl/key.pem
sudo cp /etc/letsencrypt/live/example.com/chain.pem .ssl/ca.pem
sudo chown $USER:$USER .ssl/*.pem
```

### Option 2: Purchase from Certificate Authority

1. Generate CSR (Certificate Signing Request)
2. Purchase certificate from CA (DigiCert, Comodo, etc.)
3. Download certificate files
4. Place in `.ssl/` directory with appropriate names

### Option 3: Self-Signed Certificate (Development/Testing Only)

```bash
# Generate self-signed certificate (valid for 365 days)
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout .ssl/key.pem \
  -out .ssl/cert.pem \
  -days 365 \
  -subj "/CN=localhost"

# Browsers will show security warning for self-signed certificates
```

## Port Requirements

### Standard Configuration (Recommended)

- **HTTPS**: Port 443 (default HTTPS port)
- **HTTP Redirect**: Port 80 (default HTTP port)

### Port Permissions

Ports 80 and 443 require root/administrator privileges on most systems.

#### Linux Solutions

**Option 1: Run with sudo (simple but not recommended for production)**
```bash
sudo npm start
```

**Option 2: Grant CAP_NET_BIND_SERVICE capability (recommended)**
```bash
# Allow Node.js to bind to privileged ports without sudo
sudo setcap cap_net_bind_service=+ep $(which node)

# Now run normally
npm start
```

**Option 3: Use reverse proxy (best for production)**
```bash
# Install nginx
sudo apt-get install nginx

# Configure nginx to proxy to your application
# See nginx configuration example below
```

**Option 4: Port forwarding with iptables**
```bash
# Forward port 80 to 8080, 443 to 8443
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080
sudo iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 8443

# Then configure your app to use ports 8080 and 8443
```

## Nginx Reverse Proxy (Production Recommended)

Using nginx as a reverse proxy is the best practice for production deployments.

### nginx Configuration

Create `/etc/nginx/sites-available/otc-broker`:

```nginx
# HTTP server - redirect to HTTPS
server {
    listen 80;
    server_name example.com;

    # Redirect all HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name example.com;

    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Proxy to application
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and restart:

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/otc-broker /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx
```

When using nginx, configure your app to use port 8080 (HTTP only):

```bash
# .env
PORT=8080
BASE_URL=https://example.com
PRODUCTION_MODE=true

# No need for .ssl directory - nginx handles SSL
```

## Environment Variables

### SSL and URL Configuration

```bash
# Explicit BASE_URL (overrides auto-detection)
BASE_URL=https://example.com

# Domain for auto-detection
DOMAIN=example.com

# Or public IP
PUBLIC_IP=203.0.113.10

# Production mode
PRODUCTION_MODE=true

# Custom ports (if not using 80/443)
PORT=8443                    # HTTPS port
HTTP_REDIRECT_PORT=8080      # HTTP redirect port (future enhancement)
```

## Troubleshooting

### SSL Certificates Not Detected

**Symptom**: Server starts in HTTP mode despite having certificates

**Solutions**:
1. Check `.ssl` directory exists in project root: `ls -la .ssl/`
2. Verify certificate file names match supported patterns
3. Check file permissions: `chmod 600 .ssl/*.pem`
4. View detailed logs on startup

### Permission Denied on Port 80/443

**Symptom**: `EACCES` error when starting server

**Solutions**:
- Grant CAP_NET_BIND_SERVICE: `sudo setcap cap_net_bind_service=+ep $(which node)`
- Use reverse proxy (nginx)
- Run with sudo (not recommended for production)
- Use port forwarding

### Certificate Validation Failed

**Symptom**: SSL certificates appear invalid

**Solutions**:
1. Check certificate format: `openssl x509 -in .ssl/cert.pem -text -noout`
2. Check private key format: `openssl rsa -in .ssl/key.pem -check`
3. Verify certificate and key match:
   ```bash
   openssl x509 -noout -modulus -in .ssl/cert.pem | openssl md5
   openssl rsa -noout -modulus -in .ssl/key.pem | openssl md5
   # Both should output the same hash
   ```

### HTTP Redirect Not Working

**Symptom**: HTTPS works but HTTP doesn't redirect

**Solutions**:
- Check port 80 permissions (see above)
- Verify no other service is using port 80: `sudo lsof -i :80`
- Check firewall rules: `sudo iptables -L`
- HTTPS server still works - only redirect is affected

### Wrong BASE_URL in Links

**Symptom**: Generated links use wrong protocol or domain

**Solutions**:
1. Set explicit `BASE_URL` in `.env`
2. Set `DOMAIN` environment variable for production
3. Check server startup logs for configured BASE_URL
4. Restart server after changing environment variables

## Security Best Practices

### Certificate Management

1. **Keep private keys secure**
   ```bash
   chmod 600 .ssl/*.pem
   chown root:root .ssl/*.pem  # If running as root
   ```

2. **Regular renewal** (Let's Encrypt certificates expire every 90 days)
   ```bash
   # Set up automatic renewal
   sudo crontab -e
   # Add: 0 0 * * * certbot renew --quiet && systemctl reload nginx
   ```

3. **Use strong ciphers** (handled automatically by the implementation)

4. **Enable HSTS** (HTTP Strict Transport Security)
   - Automatically enabled in redirect server
   - Tells browsers to always use HTTPS

### General Security

1. **Never commit certificates to git**
   - `.ssl/` directory is in `.gitignore`
   - Use secure deployment methods

2. **Use environment variables for secrets**
   - Never hardcode sensitive values
   - Use `.env` file (not committed)

3. **Monitor certificate expiration**
   - Set up alerts 30 days before expiration
   - Use monitoring tools (UptimeRobot, Pingdom, etc.)

4. **Keep Node.js and dependencies updated**
   ```bash
   npm audit
   npm update
   ```

## Testing

### Test HTTP Redirect

```bash
# Should redirect to HTTPS
curl -I http://example.com
# Response should include: Location: https://example.com

# Follow redirects
curl -L http://example.com/api/status
```

### Test HTTPS

```bash
# Test HTTPS connection
curl -I https://example.com

# Test with self-signed certificate (ignore verification)
curl -k https://localhost
```

### Test SSL Certificate

```bash
# Check certificate details
openssl s_client -connect example.com:443 -servername example.com

# Test SSL rating (external service)
# Visit: https://www.ssllabs.com/ssltest/analyze.html?d=example.com
```

## Architecture

### Components

1. **SSL Loader** (`config/ssl-loader.ts`)
   - Detects and loads SSL certificates from `.ssl/` directory
   - Validates certificate format and compatibility
   - Supports multiple naming conventions

2. **Server Configuration** (`config/server-config.ts`)
   - Auto-detects appropriate server configuration
   - Determines BASE_URL based on environment
   - Handles production vs development modes

3. **HTTP Redirect Server** (`services/http-redirect.ts`)
   - Lightweight HTTP server for redirecting to HTTPS
   - Implements permanent redirects (301)
   - Includes HSTS headers for security

4. **Main Server** (`index.ts`)
   - Orchestrates all components
   - Creates HTTPS server when SSL available
   - Manages graceful shutdown

### Flow Diagram

```
Startup
   ↓
Check for .ssl/ directory
   ↓
   ├─ SSL Found ────────────────┐
   │                            ↓
   │                    Create HTTPS server (port 443)
   │                            ↓
   │                    Start HTTP redirect (port 80)
   │                            ↓
   │                    BASE_URL = https://domain
   │
   ├─ No SSL (Production) ──────┐
   │                            ↓
   │                    Create HTTP server (port 80)
   │                            ↓
   │                    BASE_URL = http://domain
   │
   └─ No SSL (Development) ─────┐
                                ↓
                        Create HTTP server (port 8080)
                                ↓
                        BASE_URL = http://localhost:8080
```

## Additional Resources

- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [Mozilla SSL Configuration Generator](https://ssl-config.mozilla.org/)
- [SSL Labs Server Test](https://www.ssllabs.com/ssltest/)
- [Node.js HTTPS Documentation](https://nodejs.org/api/https.html)
- [Express behind proxies](https://expressjs.com/en/guide/behind-proxies.html)
