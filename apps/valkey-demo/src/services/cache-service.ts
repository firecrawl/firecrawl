import { getValkeyClient } from '../valkey-client';
import { config } from '../config';
import { ScrapeResult, CrawlResult } from '../firecrawl-client';
import { TimeUnit } from '@valkey/valkey-glide';

/**
 * Caching service for Firecrawl results using Valkey GLIDE
 * Demonstrates caching patterns for web scraping data
 */
export class CacheService {
  private prefix = 'demo:cache';
  private ttlSeconds: number;

  constructor(ttlSeconds?: number) {
    this.ttlSeconds = ttlSeconds ?? config.cache.ttlSeconds;
  }

  private generateKey(type: string, url: string): string {
    // Create a simple hash of the URL for the key
    const urlHash = Buffer.from(url).toString('base64').slice(0, 32);
    return `${this.prefix}:${type}:${urlHash}`;
  }

  async getCachedScrape(url: string): Promise<ScrapeResult | null> {
    const client = await getValkeyClient();
    const key = this.generateKey('scrape', url);
    
    const cached = await client.get(key);
    if (cached) {
      console.log(`[Cache] HIT for scrape: ${url}`);
      return JSON.parse(cached.toString());
    }
    
    console.log(`[Cache] MISS for scrape: ${url}`);
    return null;
  }

  async cacheScrapeResult(url: string, result: ScrapeResult): Promise<void> {
    if (!result.success) return; // Don't cache failures
    
    const client = await getValkeyClient();
    const key = this.generateKey('scrape', url);
    
    await client.set(key, JSON.stringify(result), { expiry: { type: TimeUnit.Seconds, count: this.ttlSeconds } });
    console.log(`[Cache] Stored scrape result for: ${url} (TTL: ${this.ttlSeconds}s)`);
  }

  async getCachedCrawl(crawlId: string): Promise<CrawlResult | null> {
    const client = await getValkeyClient();
    const key = `${this.prefix}:crawl:${crawlId}`;
    
    const cached = await client.get(key);
    if (cached) {
      console.log(`[Cache] HIT for crawl: ${crawlId}`);
      return JSON.parse(cached.toString());
    }
    
    console.log(`[Cache] MISS for crawl: ${crawlId}`);
    return null;
  }

  async cacheCrawlResult(crawlId: string, result: CrawlResult): Promise<void> {
    if (!result.success || result.status !== 'completed') return;
    
    const client = await getValkeyClient();
    const key = `${this.prefix}:crawl:${crawlId}`;
    
    await client.set(key, JSON.stringify(result), { expiry: { type: TimeUnit.Seconds, count: this.ttlSeconds } });
    console.log(`[Cache] Stored crawl result: ${crawlId} (TTL: ${this.ttlSeconds}s)`);
  }

  async invalidate(pattern: string): Promise<number> {
    const client = await getValkeyClient();
    // GLIDE uses scan for pattern matching
    const keys: string[] = [];
    let cursor = '0';
    
    do {
      const result = await client.customCommand(['SCAN', cursor, 'MATCH', `${this.prefix}:${pattern}*`, 'COUNT', '100']);
      const [nextCursor, foundKeys] = result as [string, string[]];
      cursor = nextCursor.toString();
      keys.push(...foundKeys.map(k => k.toString()));
    } while (cursor !== '0');
    
    if (keys.length > 0) {
      await client.del(keys);
      console.log(`[Cache] Invalidated ${keys.length} keys matching: ${pattern}`);
    }
    
    return keys.length;
  }

  async getStats(): Promise<{ keys: number; memoryUsage: string }> {
    const client = await getValkeyClient();
    
    // Count keys with our prefix
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await client.customCommand(['SCAN', cursor, 'MATCH', `${this.prefix}:*`, 'COUNT', '100']);
      const [nextCursor, foundKeys] = result as [string, string[]];
      cursor = nextCursor.toString();
      keys.push(...foundKeys.map(k => k.toString()));
    } while (cursor !== '0');

    // Get memory info
    const info = await client.customCommand(['INFO', 'memory']);
    const infoStr = info?.toString() || '';
    const memMatch = infoStr.match(/used_memory_human:(\S+)/);
    
    return {
      keys: keys.length,
      memoryUsage: memMatch?.[1] || 'unknown',
    };
  }
}
