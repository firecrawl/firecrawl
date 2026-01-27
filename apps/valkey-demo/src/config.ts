import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  firecrawl: {
    apiUrl: process.env.FIRECRAWL_API_URL || 'http://localhost:3002',
    apiKey: process.env.FIRECRAWL_API_KEY || 'fc-test-key',
  },
  valkey: {
    url: process.env.VALKEY_URL || 'redis://localhost:6379',
  },
  rateLimit: {
    max: parseInt(process.env.DEMO_RATE_LIMIT_MAX || '10', 10),
    windowMs: parseInt(process.env.DEMO_RATE_LIMIT_WINDOW_MS || '60000', 10),
  },
  cache: {
    ttlSeconds: parseInt(process.env.DEMO_CACHE_TTL_SECONDS || '3600', 10),
  },
};
