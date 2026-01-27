# Firecrawl + Valkey GLIDE Demo

A comprehensive demo showcasing Firecrawl running with [Valkey](https://valkey.io/) using the official [Valkey GLIDE](https://glide.valkey.io/) client. This demonstrates caching, rate limiting, and batch operations as a reference implementation.

## Features

- **Rate Limiting** - Sliding window rate limiter using Valkey sorted sets
- **Caching** - Cache scrape/crawl results to reduce API calls
- **Batch Operations** - Process multiple URLs with progress tracking and state persistence
- **Web UI** - Interactive dashboard to test all features

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm
- Docker (for running Firecrawl + Valkey)

### 1. Start Firecrawl with Valkey

From the Firecrawl root directory:

```bash
# Ensure Valkey is enabled in docker-compose.yaml (it is by default)
docker compose up -d
```

This starts:
- Firecrawl API on `localhost:3002`
- Valkey on `localhost:6379`

### 2. Setup the Demo

```bash
cd apps/valkey-demo
pnpm install
cp .env.example .env
```

### 3. Run the Demo

**Web UI (recommended):**
```bash
pnpm run server
# Open http://localhost:3030
```

**CLI demos:**
```bash
pnpm run demo:all          # Run all demos
pnpm run demo:rate-limit   # Rate limiting only
pnpm run demo:scrape       # Caching demo
pnpm run demo:crawl        # Crawl state tracking
pnpm run demo:batch        # Batch operations
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRECRAWL_API_URL` | `http://localhost:3002` | Firecrawl API endpoint |
| `FIRECRAWL_API_KEY` | `fc-test-key` | API key for authentication |
| `VALKEY_URL` | `redis://localhost:6379` | Valkey connection URL |
| `DEMO_RATE_LIMIT_MAX` | `10` | Max requests per window |
| `DEMO_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `DEMO_CACHE_TTL_SECONDS` | `3600` | Cache TTL in seconds |

### Connecting to Different Valkey Instances

**Local Valkey:**
```env
VALKEY_URL=redis://localhost:6379
```

**AWS ElastiCache (Valkey mode):**
```env
VALKEY_URL=rediss://your-cluster.cache.amazonaws.com:6379
```

**AWS MemoryDB:**
```env
VALKEY_URL=rediss://your-cluster.memorydb.amazonaws.com:6379
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Demo Application                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Rate Limiter│  │   Cache     │  │   Batch Manager     │  │
│  │  (sorted    │  │  (string    │  │  (hash + set        │  │
│  │   sets)     │  │   keys)     │  │   structures)       │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         └────────────────┼─────────────────────┘             │
│                          │                                   │
│                   Valkey GLIDE Client                        │
└──────────────────────────┼───────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       ┌─────────────┐          ┌─────────────┐
       │   Valkey    │          │  Firecrawl  │
       │   :6379     │          │  API :3002  │
       └─────────────┘          └─────────────┘
```

## Demo Components

### Rate Limiter (`src/services/rate-limiter.ts`)

Implements sliding window rate limiting using Valkey sorted sets:

```typescript
const rateLimiter = new RateLimiter(10, 60000); // 10 req/min
const result = await rateLimiter.checkLimit('user-123');
// { allowed: true, remaining: 9, resetAt: 1234567890 }
```

**Valkey commands used:** `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `PEXPIRE`

### Cache Service (`src/services/cache-service.ts`)

Caches Firecrawl results with configurable TTL:

```typescript
const cache = new CacheService(3600); // 1 hour TTL
const cached = await cache.getCachedScrape(url);
if (!cached) {
  const result = await firecrawl.scrape(url);
  await cache.cacheScrapeResult(url, result);
}
```

**Valkey commands used:** `GET`, `SET` with `EX`, `SCAN`, `DEL`

### Batch Manager (`src/services/batch-manager.ts`)

Manages batch scraping jobs with state persistence:

```typescript
const batchManager = new BatchManager();
const batchId = await batchManager.createBatch(urls);
const result = await batchManager.processBatch(batchId);
```

**Valkey commands used:** `HSET`, `HGET`, `SADD`, `SREM`, `SMEMBERS`

## API Endpoints (Web Server)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check with Valkey status |
| `/api/rate-limit/:id` | GET | Get rate limit status |
| `/api/rate-limit/:id/check` | POST | Check/consume rate limit |
| `/api/rate-limit/:id/reset` | POST | Reset rate limit |
| `/api/scrape` | POST | Scrape URL with caching |
| `/api/cache/stats` | GET | Get cache statistics |
| `/api/cache/clear` | POST | Clear all cached items |
| `/api/batch` | POST | Create batch job |
| `/api/batch/:id` | GET | Get batch status |
| `/api/batch/:id/process` | POST | Process batch |
| `/api/batches` | GET | List active batches |

## Troubleshooting

### Connection Issues

**"Connection refused" to Valkey:**
```bash
# Check if Valkey is running
docker compose ps
# Should show redis service as "running"

# Test connection
docker compose exec redis redis-cli ping
# Should return "PONG"
```

**"Connection timeout" with GLIDE:**
- Ensure you're not using TLS (`redis://`) for local Valkey
- For TLS connections (AWS), use `rediss://` and enable TLS in client config

### Rate Limiting Not Working

```bash
# Check if keys are being created
docker compose exec redis redis-cli keys "demo:ratelimit:*"

# Monitor commands in real-time
docker compose exec redis redis-cli monitor
```

### Cache Not Persisting

```bash
# Check cache keys
docker compose exec redis redis-cli keys "demo:cache:*"

# Check TTL on a key
docker compose exec redis redis-cli ttl "demo:cache:scrape:..."
```

## Best Practices

### 1. Connection Management

```typescript
// Reuse client connections - don't create new ones per request
const client = await getValkeyClient(); // Singleton pattern
```

### 2. Key Naming

Use consistent prefixes for organization:
```
demo:ratelimit:{identifier}
demo:cache:scrape:{url_hash}
demo:cache:crawl:{crawl_id}
demo:batch:{batch_id}
```

### 3. TTL Strategy

- **Rate limit keys:** Auto-expire with window duration
- **Cache keys:** Set based on data freshness requirements
- **Batch keys:** Clean up completed batches periodically

### 4. Error Handling

```typescript
try {
  const client = await getValkeyClient();
  await client.set(key, value);
} catch (error) {
  // Log error, fall back to non-cached behavior
  console.error('Valkey error:', error);
}
```

### 5. Production Considerations

- Use connection pooling for high-throughput
- Enable TLS for cloud deployments
- Set appropriate timeouts
- Monitor memory usage with `INFO memory`
- Use `SCAN` instead of `KEYS` for production

## File Structure

```
apps/valkey-demo/
├── public/
│   └── index.html          # Web UI
├── src/
│   ├── config.ts           # Environment configuration
│   ├── valkey-client.ts    # GLIDE client singleton
│   ├── firecrawl-client.ts # Firecrawl API client
│   ├── server.ts           # Express API server
│   ├── index.ts            # CLI demo runner
│   ├── services/
│   │   ├── rate-limiter.ts # Rate limiting service
│   │   ├── cache-service.ts# Caching service
│   │   └── batch-manager.ts# Batch job manager
│   └── demos/
│       ├── rate-limit-demo.ts
│       ├── scrape-demo.ts
│       ├── crawl-demo.ts
│       └── batch-demo.ts
├── docs/
│   ├── DEPLOYMENT.md       # Deployment guide
│   └── AWS_SETUP.md        # AWS ElastiCache/MemoryDB setup
├── deploy/
│   ├── docker-compose.valkey.yaml
│   └── kubernetes/
├── package.json
├── tsconfig.json
└── .env.example
```

## License

Apache-2.0 - Same as Firecrawl
