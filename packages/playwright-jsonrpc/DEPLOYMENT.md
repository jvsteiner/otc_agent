# Deployment Guide

Complete deployment guide for the Playwright JSON-RPC Service.

## Quick Start

### 1. Local Development

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install --with-deps

# Copy environment file
cp .env.example .env

# Edit .env and set your API_KEY
vim .env

# Run development server
npm run dev
```

### 2. Docker Deployment (Recommended)

```bash
# Build and test Docker image
./deploy.sh test-docker

# Run with Docker Compose
./deploy.sh docker-compose-up

# Check logs
docker-compose logs -f playwright-jsonrpc

# Access service
curl http://localhost:3337/health
```

### 3. Kubernetes Deployment

```bash
# Update configuration
cd k8s/
vim secret.yaml     # Set your API key
vim ingress.yaml    # Set your domain

# Deploy to cluster
./deploy.sh k8s-deploy

# Check status
kubectl get all -n playwright-jsonrpc

# View logs
./deploy.sh k8s-logs
```

## Deployment Files Overview

```
packages/playwright-jsonrpc/
├── Dockerfile                    # Multi-stage Docker build
├── .dockerignore                 # Docker build context exclusions
├── docker-compose.yml            # Docker Compose configuration
├── deploy.sh                     # Deployment helper script
├── .github/workflows/ci.yml      # CI/CD pipeline
├── k8s/                          # Kubernetes manifests
│   ├── namespace.yaml            # Namespace definition
│   ├── secret.yaml               # API key secret
│   ├── configmap.yaml            # Configuration
│   ├── deployment.yaml           # Deployment spec
│   ├── service.yaml              # Service definition
│   ├── ingress.yaml              # Ingress with TLS
│   ├── hpa.yaml                  # Auto-scaling
│   ├── pdb.yaml                  # Pod disruption budget
│   ├── serviceaccount.yaml       # RBAC configuration
│   ├── networkpolicy.yaml        # Network security
│   ├── kustomization.yaml        # Kustomize config
│   └── README.md                 # K8s deployment guide
└── DEPLOYMENT.md                 # This file
```

## Deployment Options

### Option 1: Docker (Single Container)

**Best for**: Development, testing, small deployments

**Pros**:
- Simple setup
- Easy to debug
- Minimal infrastructure

**Cons**:
- Single point of failure
- Manual scaling
- No built-in load balancing

**Deploy**:
```bash
./deploy.sh docker-build
./deploy.sh docker-run
```

### Option 2: Docker Compose

**Best for**: Development, staging, small production deployments

**Pros**:
- Multi-service orchestration
- Easy local development
- Development and production profiles
- Optional monitoring stack

**Cons**:
- Limited scaling
- No advanced orchestration
- Single host limitation

**Deploy**:
```bash
# Production
./deploy.sh docker-compose-up

# Development with hot reload
docker-compose --profile dev up -d playwright-jsonrpc-dev

# With monitoring
docker-compose --profile monitoring up -d
```

### Option 3: Kubernetes

**Best for**: Production, high availability, auto-scaling

**Pros**:
- High availability (2+ replicas)
- Automatic scaling (HPA)
- Rolling updates
- Self-healing
- Advanced networking
- Production-grade monitoring

**Cons**:
- More complex setup
- Requires K8s cluster
- Higher operational overhead

**Deploy**:
```bash
./deploy.sh k8s-deploy
```

### Option 4: Cloud Platforms

**AWS ECS/Fargate**:
```bash
# Build and push
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker build -t playwright-jsonrpc:latest .
docker tag playwright-jsonrpc:latest <account>.dkr.ecr.us-east-1.amazonaws.com/playwright-jsonrpc:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/playwright-jsonrpc:latest
```

**Google Cloud Run**:
```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/playwright-jsonrpc
gcloud run deploy playwright-jsonrpc \
  --image gcr.io/PROJECT_ID/playwright-jsonrpc \
  --platform managed \
  --set-env-vars API_KEY=your-api-key
```

**Azure Container Instances**:
```bash
az acr build --registry myregistry --image playwright-jsonrpc:latest .
az container create --resource-group myResourceGroup \
  --name playwright-jsonrpc \
  --image myregistry.azurecr.io/playwright-jsonrpc:latest
```

## Configuration Management

### Environment Variables

All configuration is done via environment variables. See `.env.example` for complete list.

**Required**:
- `API_KEY` - Authentication key (must be set!)

**Important**:
- `SESSION_TTL_MS` - Session timeout (default: 120000)
- `MAX_CONCURRENT_SESSIONS` - Max sessions (default: 8)
- `RATE_LIMIT_MAX` - Rate limit (default: 120/min)

**Security**:
- `ALLOW_HOST_REGEX` - Host validation pattern

### Docker Environment

**Using .env file**:
```bash
# Create .env
cp .env.example .env
vim .env

# Run with env file
docker-compose up -d
```

**Using environment variables**:
```bash
docker run -d \
  -e API_KEY=your-key \
  -e HEADLESS=true \
  -e MAX_CONCURRENT_SESSIONS=8 \
  playwright-jsonrpc:latest
```

### Kubernetes Secrets

**Update secret**:
```bash
# Edit secret
vim k8s/secret.yaml

# Or use kubectl
kubectl create secret generic playwright-jsonrpc-secret \
  --from-literal=api-key=your-secure-api-key \
  -n playwright-jsonrpc \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Production secret management**:
```bash
# Use external secrets operator (recommended)
# See k8s/secret.yaml for example configuration
```

## CI/CD Pipeline

### GitHub Actions Workflow

The `.github/workflows/ci.yml` provides:

1. **Automated Testing**
   - Unit tests on Node 18.x and 20.x
   - Code linting and formatting
   - TypeScript type checking
   - Test coverage reporting

2. **Security Scanning**
   - npm audit
   - Snyk vulnerability scanning
   - Trivy filesystem scanning
   - Docker image scanning

3. **Docker Build**
   - Multi-stage build
   - Build caching
   - Image testing
   - Health check verification

4. **Integration Testing**
   - Docker Compose testing
   - End-to-end API testing

5. **Image Publishing**
   - Push to GitHub Container Registry
   - Automatic tagging (latest, sha, version)

### Manual Workflow Trigger

```bash
# Trigger CI/CD manually
gh workflow run ci.yml

# View workflow status
gh run list --workflow=ci.yml
```

### Using Published Images

```bash
# Pull latest image
docker pull ghcr.io/your-org/playwright-jsonrpc:latest

# Pull specific version
docker pull ghcr.io/your-org/playwright-jsonrpc:main-abc123

# Run published image
docker run -d -p 3337:3337 \
  -e API_KEY=your-key \
  ghcr.io/your-org/playwright-jsonrpc:latest
```

## Deployment Helper Script

The `deploy.sh` script provides convenient commands:

```bash
# Docker commands
./deploy.sh docker-build          # Build Docker image
./deploy.sh docker-run            # Run Docker container
./deploy.sh docker-compose-up     # Start with Docker Compose
./deploy.sh docker-compose-down   # Stop Docker Compose

# Kubernetes commands
./deploy.sh k8s-deploy           # Deploy to Kubernetes
./deploy.sh k8s-update           # Update deployment
./deploy.sh k8s-delete           # Delete resources
./deploy.sh k8s-logs             # View logs

# Testing commands
./deploy.sh test-docker          # Build and test Docker
./deploy.sh test-k8s             # Test K8s deployment

# Help
./deploy.sh help
```

## Health Checks and Monitoring

### Health Endpoint

```bash
# Check service health
curl http://localhost:3337/health

# Response
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

### Docker Health Checks

Built into Dockerfile:
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3337/health || exit 1
```

Check health:
```bash
docker ps  # Shows health status
docker inspect playwright-jsonrpc | grep -A5 Health
```

### Kubernetes Health Checks

Three types of probes configured:

1. **Liveness**: Restarts unhealthy pods
2. **Readiness**: Removes unready pods from service
3. **Startup**: Allows sufficient startup time

View probe status:
```bash
kubectl describe pod -n playwright-jsonrpc <pod-name>
```

### Monitoring Stack (Optional)

Start with monitoring:
```bash
docker-compose --profile monitoring up -d
```

Access:
- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3000 (admin/admin)

## Scaling

### Docker Compose

```bash
# Scale to 3 replicas
docker-compose up -d --scale playwright-jsonrpc=3
```

### Kubernetes

**Manual scaling**:
```bash
kubectl scale deployment playwright-jsonrpc \
  -n playwright-jsonrpc --replicas=5
```

**Auto-scaling** (HPA):
- Automatically scales 2-10 pods
- Based on CPU (70%) and memory (80%)
- Configured in `k8s/hpa.yaml`

View scaling:
```bash
kubectl get hpa -n playwright-jsonrpc
```

## Security Hardening

### Pre-deployment Checklist

- [ ] Set strong API key (32+ characters)
- [ ] Configure restrictive `ALLOW_HOST_REGEX`
- [ ] Enable HTTPS/TLS for external access
- [ ] Use secret management (not env files in production)
- [ ] Set appropriate rate limits
- [ ] Configure resource limits
- [ ] Enable network policies (Kubernetes)
- [ ] Use specific image tags (not `latest`)
- [ ] Review and restrict RBAC permissions
- [ ] Enable audit logging
- [ ] Set up monitoring and alerting
- [ ] Regular security scanning
- [ ] Implement backup procedures

### Network Security

**Docker**:
- Use custom networks
- Restrict port exposure
- Enable firewall rules

**Kubernetes**:
- NetworkPolicy enabled (see `k8s/networkpolicy.yaml`)
- Restricts ingress and egress traffic
- Only allows required connections

### Container Security

- Non-root user (UID 1001)
- Read-only root filesystem where possible
- Dropped capabilities
- Security contexts enforced
- Regular vulnerability scanning

## Troubleshooting

### Docker Issues

**Container won't start**:
```bash
# Check logs
docker logs playwright-jsonrpc

# Common issues:
# - API_KEY not set
# - Port 3337 already in use
# - Insufficient resources
```

**High memory usage**:
```bash
# Reduce sessions
docker run -e MAX_CONCURRENT_SESSIONS=4 ...

# Monitor usage
docker stats playwright-jsonrpc
```

### Kubernetes Issues

**Pods not starting**:
```bash
# Check pod status
kubectl get pods -n playwright-jsonrpc

# View events
kubectl describe pod -n playwright-jsonrpc <pod-name>

# Check logs
kubectl logs -n playwright-jsonrpc <pod-name>
```

**Service not accessible**:
```bash
# Check service endpoints
kubectl get endpoints -n playwright-jsonrpc

# Test internal connectivity
kubectl run -it --rm debug --image=curlimages/curl -- \
  curl http://playwright-jsonrpc.playwright-jsonrpc.svc.cluster.local/health
```

### Performance Issues

**Slow response times**:
- Check resource limits (CPU/memory)
- Reduce concurrent sessions
- Optimize browser settings
- Check network latency

**Rate limiting**:
- Increase `RATE_LIMIT_MAX`
- Implement request queuing
- Use session pooling

## Backup and Disaster Recovery

### Container Images

```bash
# Save image
docker save playwright-jsonrpc:latest | gzip > playwright-jsonrpc-backup.tar.gz

# Restore image
docker load < playwright-jsonrpc-backup.tar.gz
```

### Kubernetes Configuration

```bash
# Backup all resources
kubectl get all -n playwright-jsonrpc -o yaml > backup.yaml

# Restore
kubectl apply -f backup.yaml
```

### Configuration Backup

```bash
# Backup environment
cp .env .env.backup

# Backup K8s secrets
kubectl get secret playwright-jsonrpc-secret -n playwright-jsonrpc -o yaml > secret-backup.yaml
```

## Production Deployment Workflow

1. **Prepare**
   - Update configuration (API keys, domains)
   - Review security settings
   - Test locally

2. **Build**
   - Build Docker image: `./deploy.sh docker-build`
   - Or push to trigger CI/CD

3. **Test**
   - Run tests: `./deploy.sh test-docker`
   - Verify functionality

4. **Deploy**
   - Deploy to staging first
   - Run smoke tests
   - Deploy to production

5. **Verify**
   - Check health endpoint
   - Monitor logs
   - Verify auto-scaling

6. **Monitor**
   - Set up alerts
   - Check metrics
   - Review logs regularly

## Rollback Procedures

### Docker

```bash
# Stop current container
docker stop playwright-jsonrpc

# Run previous version
docker run -d --name playwright-jsonrpc \
  -e API_KEY=your-key \
  playwright-jsonrpc:previous-tag
```

### Kubernetes

```bash
# Rollback deployment
kubectl rollout undo deployment/playwright-jsonrpc -n playwright-jsonrpc

# Rollback to specific revision
kubectl rollout undo deployment/playwright-jsonrpc \
  -n playwright-jsonrpc --to-revision=2

# View rollout history
kubectl rollout history deployment/playwright-jsonrpc -n playwright-jsonrpc
```

## Support and Resources

- **Documentation**: See [README.md](README.md) for API documentation
- **Kubernetes Guide**: See [k8s/README.md](k8s/README.md) for K8s details
- **Issues**: Check pod logs and service status
- **Security**: Run vulnerability scans regularly

## Next Steps

After deployment:

1. Configure monitoring and alerting
2. Set up log aggregation
3. Implement backup procedures
4. Document runbooks
5. Train team on operations
6. Establish incident response procedures
7. Regular security audits
8. Performance testing and optimization
