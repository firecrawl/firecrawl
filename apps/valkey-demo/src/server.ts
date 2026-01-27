import express from 'express';
import path from 'path';
import { config } from './config';
import { getValkeyClient, closeValkeyClient } from './valkey-client';
import { RateLimiter } from './services/rate-limiter';
import { CacheService } from './services/cache-service';
import { BatchManager } from './services/batch-manager';
import { FirecrawlClient } from './firecrawl-client';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const rateLimiter = new RateLimiter();
const cache = new CacheService();
const batchManager = new BatchManager();
const firecrawl = new FirecrawlClient();

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    const client = await getValkeyClient();
    await client.ping();
    res.json({ status: 'ok', valkey: 'connected' });
  } catch (error: any) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Rate limit status
app.get('/api/rate-limit/:id', async (req, res) => {
  try {
    const remaining = await rateLimiter.getRemainingRequests(req.params.id);
    res.json({ identifier: req.params.id, remaining, max: config.rateLimit.max });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Check rate limit
app.post('/api/rate-limit/:id/check', async (req, res) => {
  try {
    const result = await rateLimiter.checkLimit(req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reset rate limit
app.post('/api/rate-limit/:id/reset', async (req, res) => {
  try {
    await rateLimiter.resetLimit(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Scrape with caching
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  try {
    // Check cache first
    let result = await cache.getCachedScrape(url);
    let fromCache = true;

    if (!result) {
      fromCache = false;
      result = await firecrawl.scrape(url, { formats: ['markdown'] });
      if (result.success) {
        await cache.cacheScrapeResult(url, result);
      }
    }

    return res.json({ ...result, fromCache });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Cache stats
app.get('/api/cache/stats', async (_req, res) => {
  try {
    const stats = await cache.getStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Clear cache
app.post('/api/cache/clear', async (_req, res) => {
  try {
    const count = await cache.invalidate('*');
    res.json({ cleared: count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create batch
app.post('/api/batch', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: 'URLs array required' });
  }

  try {
    const batchId = await batchManager.createBatch(urls);
    return res.json({ batchId });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Get batch status
app.get('/api/batch/:id', async (req, res) => {
  try {
    const status = await batchManager.getBatchStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    return res.json(status);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Process batch
app.post('/api/batch/:id/process', async (req, res) => {
  try {
    const result = await batchManager.processBatch(req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// List active batches
app.get('/api/batches', async (_req, res) => {
  try {
    const batches = await batchManager.listActiveBatches();
    res.json({ batches });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Valkey info
app.get('/api/valkey/info', async (_req, res) => {
  try {
    const client = await getValkeyClient();
    const info = await client.customCommand(['INFO']);
    res.json({ info: info?.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3030;

app.listen(PORT, () => {
  console.log(`\n🚀 Valkey Demo Server running at http://localhost:${PORT}`);
  console.log(`   Firecrawl API: ${config.firecrawl.apiUrl}`);
  console.log(`   Valkey: ${config.valkey.url}\n`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await closeValkeyClient();
  process.exit(0);
});
