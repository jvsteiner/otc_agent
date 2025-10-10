# Kubernetes Deployment

This directory contains Kubernetes manifests for deploying the Playwright JSON-RPC service.

## Prerequisites

- Kubernetes cluster (1.24+)
- kubectl CLI configured
- Container registry access (GitHub Container Registry or other)
- Ingress controller installed (nginx, traefik, or AWS ALB)
- Cert-manager for TLS certificates (optional)

## Quick Start

### 1. Update Configuration

Before deploying, update the following:

**Update the image registry** in `deployment.yaml`:
```yaml
image: ghcr.io/your-org/playwright-jsonrpc:latest
```

**Set your API key** in `secret.yaml`:
```yaml
stringData:
  api-key: "YOUR_SECURE_API_KEY_HERE"
```

**Update ingress host** in `ingress.yaml`:
```yaml
- host: playwright.example.com
```

### 2. Deploy to Kubernetes

```bash
# Create namespace
kubectl apply -f namespace.yaml

# Apply all manifests
kubectl apply -f .

# Or use kustomize
kubectl apply -k .
```

### 3. Verify Deployment

```bash
# Check deployment status
kubectl get all -n playwright-jsonrpc

# Check pod logs
kubectl logs -n playwright-jsonrpc -l app=playwright-jsonrpc

# Check service endpoint
kubectl get svc -n playwright-jsonrpc

# Test health endpoint
kubectl port-forward -n playwright-jsonrpc svc/playwright-jsonrpc 3337:80
curl http://localhost:3337/health
```

## Manifest Overview

| File | Description |
|------|-------------|
| `namespace.yaml` | Creates dedicated namespace |
| `secret.yaml` | API key and sensitive configuration |
| `configmap.yaml` | Non-sensitive environment configuration |
| `serviceaccount.yaml` | Service account with minimal RBAC |
| `deployment.yaml` | Main application deployment with 2 replicas |
| `service.yaml` | ClusterIP service with session affinity |
| `ingress.yaml` | External access with TLS |
| `hpa.yaml` | Horizontal Pod Autoscaler (2-10 replicas) |
| `pdb.yaml` | Pod Disruption Budget for availability |
| `networkpolicy.yaml` | Network security policies |
| `kustomization.yaml` | Kustomize configuration |

## Configuration

### Environment Variables

All configuration is managed via ConfigMap and Secret:

**ConfigMap** (`configmap.yaml`):
- Server settings (PORT, NODE_ENV)
- Session management
- Rate limiting
- Browser configuration
- Resource limits

**Secret** (`secret.yaml`):
- API_KEY (required)

### Resource Limits

Default resource allocation per pod:

```yaml
requests:
  cpu: 500m
  memory: 1Gi
limits:
  cpu: 2000m
  memory: 2Gi
```

Adjust based on your workload and cluster capacity.

### Scaling

**Manual Scaling:**
```bash
kubectl scale deployment playwright-jsonrpc -n playwright-jsonrpc --replicas=5
```

**Automatic Scaling:**

HPA is configured to scale between 2-10 replicas based on:
- CPU utilization (target: 70%)
- Memory utilization (target: 80%)

## Security Features

### Pod Security

- Non-root user (UID 1001)
- Read-only root filesystem where possible
- Dropped all capabilities except SYS_ADMIN (required for Chromium)
- Security context constraints
- No privilege escalation

### Network Security

NetworkPolicy restricts:
- Ingress: Only from ingress controller and same namespace
- Egress: DNS, HTTP/HTTPS for browser navigation

### RBAC

Service account with minimal permissions:
- Read-only access to ConfigMaps
- Read-only access to Secrets

## High Availability

### Multiple Replicas

Minimum 2 replicas for redundancy with anti-affinity rules to spread across nodes.

### Pod Disruption Budget

Ensures at least 1 pod remains available during:
- Node maintenance
- Cluster upgrades
- Voluntary disruptions

### Health Checks

- **Liveness probe**: Restarts unhealthy pods
- **Readiness probe**: Removes unready pods from service
- **Startup probe**: Allows sufficient startup time

## Ingress Configuration

### Nginx Ingress Controller

Default configuration uses nginx with:
- Automatic TLS via cert-manager
- Rate limiting (120 req/min)
- Request size limit (10MB)
- Timeout configuration

### AWS Application Load Balancer

Uncomment AWS annotations in `ingress.yaml`:
```yaml
kubernetes.io/ingress.class: alb
alb.ingress.kubernetes.io/scheme: internet-facing
```

### Custom Domain

1. Update `ingress.yaml` with your domain
2. Configure DNS to point to ingress controller
3. cert-manager will automatically provision TLS certificate

## Monitoring

### Health Endpoint

```bash
kubectl port-forward -n playwright-jsonrpc svc/playwright-jsonrpc 8080:80
curl http://localhost:8080/health
```

### Prometheus Metrics

Pods are annotated for Prometheus scraping:
```yaml
prometheus.io/scrape: "true"
prometheus.io/port: "3337"
```

### Logs

```bash
# Tail logs from all pods
kubectl logs -n playwright-jsonrpc -l app=playwright-jsonrpc -f

# Logs from specific pod
kubectl logs -n playwright-jsonrpc playwright-jsonrpc-xxx-yyy
```

## Troubleshooting

### Pod Not Starting

```bash
# Check pod events
kubectl describe pod -n playwright-jsonrpc playwright-jsonrpc-xxx

# Check logs
kubectl logs -n playwright-jsonrpc playwright-jsonrpc-xxx

# Common issues:
# - Missing secret (API_KEY)
# - Insufficient resources
# - Image pull errors
```

### Health Check Failures

```bash
# Check pod health
kubectl get pods -n playwright-jsonrpc

# Exec into pod
kubectl exec -it -n playwright-jsonrpc playwright-jsonrpc-xxx -- sh

# Test health endpoint from inside pod
curl http://localhost:3337/health
```

### Connection Issues

```bash
# Check service endpoints
kubectl get endpoints -n playwright-jsonrpc

# Check ingress
kubectl describe ingress -n playwright-jsonrpc

# Test service connectivity
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
  curl http://playwright-jsonrpc.playwright-jsonrpc.svc.cluster.local/health
```

## Production Checklist

- [ ] Update image tag to specific version (not `latest`)
- [ ] Set strong API key in secret
- [ ] Configure ingress with custom domain
- [ ] Set up TLS certificates
- [ ] Adjust resource limits based on load testing
- [ ] Configure monitoring and alerting
- [ ] Set up log aggregation
- [ ] Review and adjust HPA settings
- [ ] Configure backup for persistent data (if any)
- [ ] Set up disaster recovery procedures
- [ ] Review security policies
- [ ] Enable network policies
- [ ] Configure external secrets management (Vault, AWS Secrets Manager)

## Advanced Deployments

### Using Kustomize Overlays

```bash
# Create environment-specific overlays
mkdir -p overlays/production overlays/staging

# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
bases:
- ../../base
namespace: playwright-jsonrpc-prod
replicas:
- name: playwright-jsonrpc
  count: 5
```

### Using Helm

```bash
# Create Helm chart
helm create playwright-jsonrpc

# Deploy with Helm
helm install playwright-jsonrpc ./helm-chart \
  --namespace playwright-jsonrpc \
  --create-namespace \
  --set image.tag=v1.0.0 \
  --set ingress.hosts[0]=playwright.example.com
```

### GitOps with ArgoCD

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: playwright-jsonrpc
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/your-org/otc_agent
    targetRevision: main
    path: packages/playwright-jsonrpc/k8s
  destination:
    server: https://kubernetes.default.svc
    namespace: playwright-jsonrpc
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Cleanup

```bash
# Delete all resources
kubectl delete -f .

# Or delete namespace (removes everything)
kubectl delete namespace playwright-jsonrpc
```

## Support

For issues and questions:
- Check pod logs: `kubectl logs -n playwright-jsonrpc -l app=playwright-jsonrpc`
- Review events: `kubectl get events -n playwright-jsonrpc --sort-by='.lastTimestamp'`
- Describe resources: `kubectl describe <resource> -n playwright-jsonrpc`
