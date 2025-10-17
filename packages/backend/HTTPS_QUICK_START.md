# HTTPS Quick Start Guide

Quick reference for enabling HTTPS on the OTC Broker Engine.

## 🚀 5-Minute Setup

### Step 1: Create SSL Directory
```bash
mkdir -p .ssl
```

### Step 2: Add Certificates

Place your certificate files in `.ssl/`:
- **Certificate**: `cert.pem` (or `fullchain.pem`)
- **Private Key**: `key.pem` (or `privkey.pem`)
- **CA Bundle** (optional): `ca.pem` (or `chain.pem`)

### Step 3: Configure Environment

Add to `.env`:
```bash
DOMAIN=your-domain.com
PRODUCTION_MODE=true
```

### Step 4: Start Server
```bash
npm run build
npm start
```

**Done!** Server automatically runs HTTPS on port 443 with HTTP redirect on port 80.

---

## 📋 Certificate Options

### Option A: Self-Signed (Development)
```bash
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout .ssl/key.pem \
  -out .ssl/cert.pem \
  -days 365 \
  -subj "/CN=localhost"
```

### Option B: Let's Encrypt (Production)
```bash
# Install certbot
sudo apt-get install certbot

# Generate certificate
sudo certbot certonly --standalone -d your-domain.com

# Copy to project
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem .ssl/cert.pem
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem .ssl/key.pem
sudo chown $USER:$USER .ssl/*.pem
chmod 600 .ssl/*.pem
```

### Option C: Use Setup Script
```bash
bash packages/backend/scripts/setup-ssl-example.sh
```

---

## 🔧 Port Permissions

Ports 80 and 443 require root privileges.

### Quick Fix (Linux)
```bash
sudo setcap cap_net_bind_service=+ep $(which node)
npm start
```

### Alternative: Use Reverse Proxy
Configure nginx to handle ports 80/443, proxy to app on 8080.
See `HTTPS_SETUP.md` for nginx configuration.

---

## 🧪 Testing

### Test HTTPS
```bash
curl -I https://your-domain.com
```

### Test HTTP Redirect
```bash
curl -I http://your-domain.com
# Should return: 301 redirect to https://
```

### Test Self-Signed (ignore warnings)
```bash
curl -k https://localhost
```

---

## 📊 Server Modes

| SSL Certificates | Production Mode | Result |
|------------------|----------------|--------|
| ✅ Found | ✅ Yes | HTTPS on 443 + HTTP redirect on 80 |
| ✅ Found | ❌ No | HTTPS on 443 + HTTP redirect on 80 |
| ❌ Not Found | ✅ Yes | HTTP on 80 |
| ❌ Not Found | ❌ No | HTTP on 8080 (development) |

---

## 🔍 Troubleshooting

### "Permission denied to bind to port 80"
```bash
sudo setcap cap_net_bind_service=+ep $(which node)
```

### "No certificate file found"
Check supported names:
- `cert.pem`, `certificate.pem`, `server.crt`, `fullchain.pem`

Verify location:
```bash
ls -la .ssl/
```

### "Certificate appears invalid"
Validate certificate:
```bash
openssl x509 -in .ssl/cert.pem -text -noout
openssl rsa -in .ssl/key.pem -check
```

### Wrong BASE_URL in Links
Set explicitly in `.env`:
```bash
BASE_URL=https://your-domain.com
```

---

## 📚 Full Documentation

For complete documentation, see:
- **Setup Guide**: `packages/backend/HTTPS_SETUP.md`
- **Implementation Details**: `HTTPS_IMPLEMENTATION_SUMMARY.md`
- **Setup Script**: `packages/backend/scripts/setup-ssl-example.sh`

---

## 🎯 Production Checklist

- [ ] SSL certificates obtained (Let's Encrypt recommended)
- [ ] Certificates placed in `.ssl/` directory
- [ ] File permissions set (`chmod 600 .ssl/*.pem`)
- [ ] `DOMAIN` configured in `.env`
- [ ] `PRODUCTION_MODE=true` in `.env`
- [ ] Port permissions configured (CAP_NET_BIND_SERVICE or reverse proxy)
- [ ] Server tested with HTTPS
- [ ] HTTP redirect verified
- [ ] Certificate auto-renewal configured (Let's Encrypt)
- [ ] Monitoring/alerts set up for certificate expiration

---

## 🌐 URLs Generated

All links automatically use the configured BASE_URL:

| Mode | BASE_URL | Deal Link Example |
|------|----------|-------------------|
| Development | `http://localhost:8080` | `http://localhost:8080/d/abc123/a/token` |
| Production HTTP | `http://your-domain.com` | `http://your-domain.com/d/abc123/a/token` |
| Production HTTPS | `https://your-domain.com` | `https://your-domain.com/d/abc123/a/token` |

---

## 🆘 Need Help?

1. Check logs for configuration details at startup
2. Run the interactive setup script: `bash packages/backend/scripts/setup-ssl-example.sh`
3. Read the full setup guide: `packages/backend/HTTPS_SETUP.md`
4. Verify `.ssl/` directory contents: `ls -la .ssl/`

---

**Last Updated**: 2025-10-17
