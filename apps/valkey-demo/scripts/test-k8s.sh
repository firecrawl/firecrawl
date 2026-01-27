#!/bin/bash
# Test Kubernetes deployment for Firecrawl + Valkey
# Usage: ./scripts/test-k8s.sh [deploy|test|cleanup|all]
#
# This script uses the existing Firecrawl K8s manifests from examples/kubernetes/cluster-install
# but swaps redis.yaml for valkey.yaml
#
# Prerequisites:
#   - kubectl configured with a cluster (Docker Desktop K8s, minikube, etc.)
#   - Node.js and pnpm installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FIRECRAWL_ROOT="$(dirname "$(dirname "$PROJECT_DIR")")"
K8S_MANIFESTS="$FIRECRAWL_ROOT/examples/kubernetes/cluster-install"
NAMESPACE="default"
LOCAL_PORT=6380

cd "$PROJECT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

check_prerequisites() {
    log "Checking prerequisites..."
    
    command -v kubectl >/dev/null 2>&1 || error "kubectl not found. Install it first."
    command -v pnpm >/dev/null 2>&1 || error "pnpm not found. Install it first."
    
    # Check if cluster is accessible
    kubectl cluster-info >/dev/null 2>&1 || error "Cannot connect to Kubernetes cluster. Is it running?"
    
    # Check if manifests exist
    [ -d "$K8S_MANIFESTS" ] || error "K8s manifests not found at $K8S_MANIFESTS"
    [ -f "$K8S_MANIFESTS/valkey.yaml" ] || error "valkey.yaml not found. Run from firecrawl repo."
    
    log "Prerequisites OK"
}

deploy() {
    log "Deploying Firecrawl + Valkey to Kubernetes..."
    log "Using manifests from: $K8S_MANIFESTS"
    
    cd "$K8S_MANIFESTS"
    
    # Deploy in order
    log "Applying configmap..."
    kubectl apply -f configmap.yaml -n $NAMESPACE
    
    log "Applying secrets..."
    kubectl apply -f secret.yaml -n $NAMESPACE
    
    log "Applying Valkey (instead of Redis)..."
    kubectl apply -f valkey.yaml -n $NAMESPACE
    
    log "Applying playwright-service..."
    kubectl apply -f playwright-service.yaml -n $NAMESPACE
    
    log "Applying api..."
    kubectl apply -f api.yaml -n $NAMESPACE
    
    log "Applying worker..."
    kubectl apply -f worker.yaml -n $NAMESPACE
    
    log "Applying nuq-worker..."
    kubectl apply -f nuq-worker.yaml -n $NAMESPACE
    
    log "Applying nuq-postgres..."
    kubectl apply -f nuq-postgres.yaml -n $NAMESPACE
    
    cd "$PROJECT_DIR"
    
    log "Waiting for Valkey (redis service) to be ready..."
    kubectl wait --for=condition=available --timeout=120s deployment/redis -n $NAMESPACE || {
        warn "Valkey deployment not ready yet, checking status..."
        kubectl get pods -n $NAMESPACE
    }
    
    log "Waiting for Firecrawl API to be ready..."
    kubectl wait --for=condition=available --timeout=300s deployment/api -n $NAMESPACE || {
        warn "API deployment not ready yet. This can take a few minutes for image pull."
        kubectl get pods -n $NAMESPACE
    }
    
    # Extra wait for API to fully initialize
    log "Waiting for API to initialize (30s)..."
    sleep 30
    
    log "Deployment complete!"
    echo ""
    kubectl get pods -n $NAMESPACE
}

start_port_forward() {
    log "Starting port-forward to Valkey (redis service) on localhost:$LOCAL_PORT..."
    
    # Kill any existing port-forwards
    pkill -f "port-forward.*svc/redis.*$LOCAL_PORT" 2>/dev/null || true
    pkill -f "port-forward.*svc/api.*3002" 2>/dev/null || true
    sleep 1
    
    # Start Valkey port-forward in background
    kubectl port-forward svc/redis $LOCAL_PORT:6379 -n $NAMESPACE &
    VALKEY_PF_PID=$!
    
    # Start API port-forward in background
    log "Starting port-forward to Firecrawl API on localhost:3002..."
    kubectl port-forward svc/api 3002:3002 -n $NAMESPACE &
    API_PF_PID=$!
    
    # Wait for port-forwards to be ready
    sleep 5
    
    # Verify Valkey connection (no auth by default in the example manifests)
    if redis-cli -p $LOCAL_PORT ping 2>/dev/null | grep -q PONG; then
        log "Valkey port-forward ready (PID: $VALKEY_PF_PID)"
    else
        # Try with password from secret
        REDIS_PASS=$(kubectl get secret firecrawl-secret -n $NAMESPACE -o jsonpath='{.data.REDIS_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
        if [ -n "$REDIS_PASS" ] && redis-cli -p $LOCAL_PORT -a "$REDIS_PASS" --no-auth-warning ping | grep -q PONG; then
            log "Valkey port-forward ready with auth (PID: $VALKEY_PF_PID)"
            export VALKEY_PASSWORD="$REDIS_PASS"
        else
            warn "Could not verify Valkey connection, but continuing..."
        fi
    fi
    
    # Verify API connection
    if curl -s http://localhost:3002/v0/health/liveness >/dev/null 2>&1; then
        log "API port-forward ready (PID: $API_PF_PID)"
    else
        warn "API not responding yet. Scrape/crawl tests may fail."
    fi
}

stop_port_forward() {
    log "Stopping port-forwards..."
    pkill -f "port-forward.*svc/redis.*$LOCAL_PORT" 2>/dev/null || true
    pkill -f "port-forward.*svc/api.*3002" 2>/dev/null || true
}

run_tests() {
    log "Running demo tests against Kubernetes Valkey..."
    
    cd "$PROJECT_DIR"
    
    # Ensure dependencies are installed
    if [ ! -d "node_modules" ]; then
        log "Installing dependencies..."
        pnpm install
    fi
    
    # Build connection URL
    if [ -n "$VALKEY_PASSWORD" ]; then
        VALKEY_URL="redis://:$VALKEY_PASSWORD@localhost:$LOCAL_PORT"
    else
        VALKEY_URL="redis://localhost:$LOCAL_PORT"
    fi
    
    log "Connecting to Valkey: $VALKEY_URL"
    log "Connecting to Firecrawl API: http://localhost:3002"
    
    # Run the demo
    VALKEY_URL="$VALKEY_URL" FIRECRAWL_API_URL="http://localhost:3002" pnpm run demo:all
    
    log "Tests complete!"
}

cleanup() {
    log "Cleaning up Kubernetes resources..."
    
    stop_port_forward
    
    cd "$K8S_MANIFESTS"
    
    kubectl delete -f nuq-postgres.yaml -n $NAMESPACE --ignore-not-found=true
    kubectl delete -f nuq-worker.yaml -n $NAMESPACE --ignore-not-found=true
    kubectl delete -f worker.yaml -n $NAMESPACE --ignore-not-found=true
    kubectl delete -f api.yaml -n $NAMESPACE --ignore-not-found=true
    kubectl delete -f playwright-service.yaml -n $NAMESPACE --ignore-not-found=true
    kubectl delete -f valkey.yaml -n $NAMESPACE --ignore-not-found=true
    kubectl delete -f secret.yaml -n $NAMESPACE --ignore-not-found=true
    kubectl delete -f configmap.yaml -n $NAMESPACE --ignore-not-found=true
    
    cd "$PROJECT_DIR"
    
    log "Cleanup complete!"
}

show_status() {
    log "Current status in namespace: $NAMESPACE"
    echo ""
    echo "Pods:"
    kubectl get pods -n $NAMESPACE 2>/dev/null || echo "  None"
    echo ""
    echo "Services:"
    kubectl get svc -n $NAMESPACE 2>/dev/null || echo "  None"
    echo ""
    echo "Deployments:"
    kubectl get deployments -n $NAMESPACE 2>/dev/null || echo "  None"
}

usage() {
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  deploy    - Deploy Firecrawl + Valkey to Kubernetes"
    echo "  test      - Run demo tests (requires deploy first)"
    echo "  cleanup   - Remove all Kubernetes resources"
    echo "  status    - Show current deployment status"
    echo "  all       - Deploy, test, and cleanup (full cycle)"
    echo ""
    echo "This script uses the Firecrawl K8s manifests from:"
    echo "  examples/kubernetes/cluster-install/"
    echo ""
    echo "It deploys valkey.yaml instead of redis.yaml to use Valkey."
    echo ""
    echo "Examples:"
    echo "  $0 deploy     # Deploy to K8s"
    echo "  $0 test       # Run tests"
    echo "  $0 cleanup    # Clean up"
    echo "  $0 all        # Full test cycle"
}

# Main
case "${1:-all}" in
    deploy)
        check_prerequisites
        deploy
        ;;
    test)
        check_prerequisites
        start_port_forward
        run_tests
        stop_port_forward
        ;;
    cleanup)
        cleanup
        ;;
    status)
        show_status
        ;;
    all)
        check_prerequisites
        deploy
        start_port_forward
        run_tests
        stop_port_forward
        echo ""
        read -p "Press Enter to cleanup, or Ctrl+C to keep running... "
        cleanup
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo "Unknown command: $1"
        usage
        exit 1
        ;;
esac
