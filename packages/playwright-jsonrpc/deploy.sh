#!/bin/bash
set -e

# Deployment helper script for Playwright JSON-RPC Service
# This script simplifies common deployment tasks

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v $1 &> /dev/null; then
        print_error "$1 is not installed. Please install it first."
        exit 1
    fi
}

show_usage() {
    cat << EOF
Deployment Helper for Playwright JSON-RPC Service

Usage: ./deploy.sh [command] [options]

Commands:
    docker-build              Build Docker image
    docker-run               Run Docker container
    docker-compose-up        Start with Docker Compose
    docker-compose-down      Stop Docker Compose services
    k8s-deploy              Deploy to Kubernetes
    k8s-update              Update Kubernetes deployment
    k8s-delete              Delete from Kubernetes
    k8s-logs                Show Kubernetes logs
    test-docker             Build and test Docker image
    test-k8s                Test Kubernetes deployment
    help                    Show this help message

Examples:
    ./deploy.sh docker-build
    ./deploy.sh docker-run
    ./deploy.sh k8s-deploy
    ./deploy.sh k8s-logs

EOF
}

# Docker commands
docker_build() {
    print_info "Building Docker image..."
    check_command docker

    docker build \
        --target production \
        --build-arg NODE_ENV=production \
        -t playwright-jsonrpc:latest \
        .

    print_info "Docker image built successfully!"
    docker images | grep playwright-jsonrpc
}

docker_run() {
    print_info "Running Docker container..."
    check_command docker

    if [ ! -f .env ]; then
        print_warn ".env file not found. Creating from .env.example..."
        cp .env.example .env
        print_warn "Please update .env with your configuration, especially API_KEY"
        exit 1
    fi

    # Load environment variables
    set -a
    source .env
    set +a

    if [ -z "$API_KEY" ] || [ "$API_KEY" = "your-secure-api-key-here" ]; then
        print_error "Please set a secure API_KEY in .env file"
        exit 1
    fi

    docker run -d \
        --name playwright-jsonrpc \
        -p 3337:3337 \
        --env-file .env \
        --restart unless-stopped \
        --memory=2g \
        --cpus=2 \
        playwright-jsonrpc:latest

    print_info "Container started successfully!"
    print_info "Health check: curl http://localhost:3337/health"

    # Wait a few seconds and show logs
    sleep 3
    docker logs playwright-jsonrpc
}

docker_compose_up() {
    print_info "Starting services with Docker Compose..."
    check_command docker-compose

    if [ ! -f .env ]; then
        print_warn ".env file not found. Creating from .env.example..."
        cp .env.example .env
        print_warn "Please update .env with your configuration"
        exit 1
    fi

    docker-compose up -d

    print_info "Services started successfully!"
    docker-compose ps
}

docker_compose_down() {
    print_info "Stopping Docker Compose services..."
    check_command docker-compose

    docker-compose down
    print_info "Services stopped successfully!"
}

# Kubernetes commands
k8s_deploy() {
    print_info "Deploying to Kubernetes..."
    check_command kubectl

    # Check if secret is properly configured
    if grep -q "REPLACE_WITH_YOUR_SECURE_API_KEY" k8s/secret.yaml; then
        print_error "Please update k8s/secret.yaml with your API key"
        exit 1
    fi

    # Check if ingress is properly configured
    if grep -q "playwright.example.com" k8s/ingress.yaml; then
        print_warn "Warning: Using default domain (playwright.example.com)"
        print_warn "Update k8s/ingress.yaml with your actual domain"
    fi

    # Apply manifests
    kubectl apply -k k8s/

    print_info "Kubernetes resources created successfully!"
    print_info "Check status with: kubectl get all -n playwright-jsonrpc"
}

k8s_update() {
    print_info "Updating Kubernetes deployment..."
    check_command kubectl

    kubectl apply -k k8s/
    kubectl rollout restart deployment/playwright-jsonrpc -n playwright-jsonrpc

    print_info "Deployment updated successfully!"
    kubectl rollout status deployment/playwright-jsonrpc -n playwright-jsonrpc
}

k8s_delete() {
    print_info "Deleting Kubernetes resources..."
    check_command kubectl

    read -p "Are you sure you want to delete all resources? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        kubectl delete -k k8s/
        print_info "Resources deleted successfully!"
    else
        print_info "Deletion cancelled"
    fi
}

k8s_logs() {
    print_info "Showing Kubernetes logs..."
    check_command kubectl

    kubectl logs -n playwright-jsonrpc -l app=playwright-jsonrpc --tail=100 -f
}

# Testing commands
test_docker() {
    print_info "Building and testing Docker image..."

    # Build image
    docker_build

    # Run container with test API key
    print_info "Starting test container..."
    docker run -d \
        --name playwright-jsonrpc-test \
        -p 3337:3337 \
        -e API_KEY=test-api-key-123 \
        -e HEADLESS=true \
        playwright-jsonrpc:latest

    # Wait for container to start
    print_info "Waiting for container to be ready..."
    sleep 10

    # Test health endpoint
    print_info "Testing health endpoint..."
    if curl -f http://localhost:3337/health; then
        print_info "Health check passed!"
    else
        print_error "Health check failed!"
        docker logs playwright-jsonrpc-test
        docker stop playwright-jsonrpc-test
        docker rm playwright-jsonrpc-test
        exit 1
    fi

    # Test API endpoint
    print_info "Testing RPC endpoint..."
    response=$(curl -s -H "x-api-key: test-api-key-123" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"session.create","params":{}}' \
        http://localhost:3337/rpc)

    if echo "$response" | grep -q "session_id"; then
        print_info "RPC endpoint test passed!"
    else
        print_error "RPC endpoint test failed!"
        echo "Response: $response"
        docker logs playwright-jsonrpc-test
        docker stop playwright-jsonrpc-test
        docker rm playwright-jsonrpc-test
        exit 1
    fi

    # Cleanup
    print_info "Cleaning up test container..."
    docker stop playwright-jsonrpc-test
    docker rm playwright-jsonrpc-test

    print_info "All tests passed! Docker image is ready for deployment."
}

test_k8s() {
    print_info "Testing Kubernetes deployment..."
    check_command kubectl

    # Check if deployment exists
    if ! kubectl get deployment playwright-jsonrpc -n playwright-jsonrpc &> /dev/null; then
        print_error "Deployment not found. Run './deploy.sh k8s-deploy' first"
        exit 1
    fi

    # Check deployment status
    print_info "Checking deployment status..."
    kubectl get deployment playwright-jsonrpc -n playwright-jsonrpc

    # Check pod status
    print_info "Checking pod status..."
    kubectl get pods -n playwright-jsonrpc -l app=playwright-jsonrpc

    # Port forward for testing
    print_info "Setting up port forward for testing..."
    kubectl port-forward -n playwright-jsonrpc svc/playwright-jsonrpc 3337:80 &
    PF_PID=$!

    # Wait for port forward
    sleep 3

    # Test health endpoint
    print_info "Testing health endpoint..."
    if curl -f http://localhost:3337/health; then
        print_info "Health check passed!"
    else
        print_error "Health check failed!"
        kill $PF_PID
        exit 1
    fi

    # Cleanup
    kill $PF_PID

    print_info "Kubernetes deployment test passed!"
}

# Main command router
case "${1:-help}" in
    docker-build)
        docker_build
        ;;
    docker-run)
        docker_run
        ;;
    docker-compose-up)
        docker_compose_up
        ;;
    docker-compose-down)
        docker_compose_down
        ;;
    k8s-deploy)
        k8s_deploy
        ;;
    k8s-update)
        k8s_update
        ;;
    k8s-delete)
        k8s_delete
        ;;
    k8s-logs)
        k8s_logs
        ;;
    test-docker)
        test_docker
        ;;
    test-k8s)
        test_k8s
        ;;
    help|--help|-h)
        show_usage
        ;;
    *)
        print_error "Unknown command: $1"
        echo
        show_usage
        exit 1
        ;;
esac
