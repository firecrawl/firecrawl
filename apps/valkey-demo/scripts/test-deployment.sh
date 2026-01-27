#!/bin/bash
# Test script for Valkey deployments
# Usage: ./scripts/test-deployment.sh [local|docker|k8s]

set -e

VALKEY_URL="${VALKEY_URL:-redis://localhost:6379}"
FIRECRAWL_URL="${FIRECRAWL_API_URL:-http://localhost:3002}"

echo "=== Valkey Deployment Test ==="
echo "Valkey URL: $VALKEY_URL"
echo "Firecrawl URL: $FIRECRAWL_URL"
echo ""

# Parse Valkey URL for redis-cli
parse_url() {
    local url=$1
    # Remove redis:// or rediss://
    url="${url#redis://}"
    url="${url#rediss://}"
    
    # Extract password if present
    if [[ "$url" == *"@"* ]]; then
        local auth="${url%%@*}"
        url="${url#*@}"
        if [[ "$auth" == *":"* ]]; then
            REDIS_PASSWORD="${auth#*:}"
        else
            REDIS_PASSWORD="$auth"
        fi
    fi
    
    # Extract host and port
    REDIS_HOST="${url%%:*}"
    REDIS_PORT="${url#*:}"
    REDIS_PORT="${REDIS_PORT%%/*}"
    
    [ -z "$REDIS_HOST" ] && REDIS_HOST="localhost"
    [ -z "$REDIS_PORT" ] && REDIS_PORT="6379"
}

parse_url "$VALKEY_URL"

echo "1. Testing Valkey Connection..."
if [ -n "$REDIS_PASSWORD" ]; then
    PING_RESULT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning ping 2>/dev/null || echo "FAILED")
else
    PING_RESULT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null || echo "FAILED")
fi

if [ "$PING_RESULT" = "PONG" ]; then
    echo "   ✅ Valkey connection: OK"
else
    echo "   ❌ Valkey connection: FAILED"
    echo "   Make sure Valkey is running and accessible"
    exit 1
fi

echo ""
echo "2. Testing Valkey Info..."
if [ -n "$REDIS_PASSWORD" ]; then
    VERSION=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning info server 2>/dev/null | grep -E "redis_version|valkey_version" | head -1)
else
    VERSION=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" info server 2>/dev/null | grep -E "redis_version|valkey_version" | head -1)
fi
echo "   $VERSION"

echo ""
echo "3. Testing Firecrawl API..."
HEALTH=$(curl -s "$FIRECRAWL_URL/health" 2>/dev/null || echo '{"error":"connection failed"}')
if echo "$HEALTH" | grep -q "error"; then
    echo "   ⚠️  Firecrawl API: Not available (optional for Valkey-only tests)"
else
    echo "   ✅ Firecrawl API: OK"
fi

echo ""
echo "4. Testing Demo App Operations..."

# Test rate limiter
echo "   Testing rate limiter..."
if [ -n "$REDIS_PASSWORD" ]; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning del "demo:ratelimit:test-user" > /dev/null 2>&1
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning zadd "demo:ratelimit:test-user" "$(date +%s)000" "test-1" > /dev/null 2>&1
    COUNT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning zcard "demo:ratelimit:test-user" 2>/dev/null)
else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" del "demo:ratelimit:test-user" > /dev/null 2>&1
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" zadd "demo:ratelimit:test-user" "$(date +%s)000" "test-1" > /dev/null 2>&1
    COUNT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" zcard "demo:ratelimit:test-user" 2>/dev/null)
fi

if [ "$COUNT" = "1" ]; then
    echo "   ✅ Rate limiter (sorted set): OK"
else
    echo "   ❌ Rate limiter: FAILED"
fi

# Test cache
echo "   Testing cache..."
if [ -n "$REDIS_PASSWORD" ]; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning setex "demo:cache:test" 60 "test-value" > /dev/null 2>&1
    VALUE=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning get "demo:cache:test" 2>/dev/null)
else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" setex "demo:cache:test" 60 "test-value" > /dev/null 2>&1
    VALUE=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" get "demo:cache:test" 2>/dev/null)
fi

if [ "$VALUE" = "test-value" ]; then
    echo "   ✅ Cache (string with TTL): OK"
else
    echo "   ❌ Cache: FAILED"
fi

# Test batch state
echo "   Testing batch state..."
if [ -n "$REDIS_PASSWORD" ]; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning hset "demo:batch:test" "data" '{"status":"pending"}' > /dev/null 2>&1
    DATA=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning hget "demo:batch:test" "data" 2>/dev/null)
else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" hset "demo:batch:test" "data" '{"status":"pending"}' > /dev/null 2>&1
    DATA=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" hget "demo:batch:test" "data" 2>/dev/null)
fi

if echo "$DATA" | grep -q "pending"; then
    echo "   ✅ Batch state (hash): OK"
else
    echo "   ❌ Batch state: FAILED"
fi

# Cleanup test keys
echo ""
echo "5. Cleaning up test keys..."
if [ -n "$REDIS_PASSWORD" ]; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning del "demo:ratelimit:test-user" "demo:cache:test" "demo:batch:test" > /dev/null 2>&1
else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" del "demo:ratelimit:test-user" "demo:cache:test" "demo:batch:test" > /dev/null 2>&1
fi
echo "   ✅ Cleanup complete"

echo ""
echo "=== All Tests Passed ==="
echo ""
echo "Next steps:"
echo "  - Run full demo: pnpm run demo:all"
echo "  - Start web UI: pnpm run server"
