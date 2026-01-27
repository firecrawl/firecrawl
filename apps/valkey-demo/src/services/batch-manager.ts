import { getValkeyClient } from '../valkey-client';
import { FirecrawlClient, ScrapeResult } from '../firecrawl-client';
import { RateLimiter } from './rate-limiter';
import { CacheService } from './cache-service';

export interface BatchJob {
  id: string;
  urls: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  results: Record<string, ScrapeResult>;
  createdAt: number;
  completedAt?: number;
}

/**
 * Batch operation manager using Valkey GLIDE for state management
 * Demonstrates batch processing with progress tracking
 */
export class BatchManager {
  private prefix = 'demo:batch';
  private firecrawl: FirecrawlClient;
  private rateLimiter: RateLimiter;
  private cache: CacheService;

  constructor() {
    this.firecrawl = new FirecrawlClient();
    this.rateLimiter = new RateLimiter();
    this.cache = new CacheService();
  }

  async createBatch(urls: string[]): Promise<string> {
    const client = await getValkeyClient();
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    const job: BatchJob = {
      id: batchId,
      urls,
      status: 'pending',
      progress: 0,
      results: {},
      createdAt: Date.now(),
    };

    await client.hset(`${this.prefix}:${batchId}`, [{ field: 'data', value: JSON.stringify(job) }]);
    await client.sadd(`${this.prefix}:active`, [batchId]);
    
    console.log(`[Batch] Created batch ${batchId} with ${urls.length} URLs`);
    return batchId;
  }

  async processBatch(batchId: string, concurrency: number = 3): Promise<BatchJob> {
    const client = await getValkeyClient();
    const jobData = await client.hget(`${this.prefix}:${batchId}`, 'data');
    
    if (!jobData) {
      throw new Error(`Batch ${batchId} not found`);
    }

    const job = JSON.parse(jobData.toString()) as BatchJob;
    job.status = 'processing';
    job.results = {};

    await this.updateJobState(batchId, job);

    const results: Record<string, ScrapeResult> = {};
    const urls = [...job.urls];
    let completed = 0;

    const processUrl = async (url: string): Promise<void> => {
      const rateCheck = await this.rateLimiter.checkLimit('batch-scrape');
      if (!rateCheck.allowed) {
        console.log(`[Batch] Rate limited, waiting...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      let result = await this.cache.getCachedScrape(url);
      
      if (!result) {
        result = await this.firecrawl.scrape(url);
        if (result.success) {
          await this.cache.cacheScrapeResult(url, result);
        }
      }

      results[url] = result;
      completed++;
      job.progress = Math.round((completed / job.urls.length) * 100);
      job.results = results;
      
      await this.updateJobState(batchId, job);
      console.log(`[Batch] Progress: ${job.progress}% (${completed}/${job.urls.length})`);
    };

    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      await Promise.all(batch.map(processUrl));
    }

    job.status = 'completed';
    job.progress = 100;
    job.completedAt = Date.now();

    await this.updateJobState(batchId, job);
    await client.srem(`${this.prefix}:active`, [batchId]);
    await client.sadd(`${this.prefix}:completed`, [batchId]);

    console.log(`[Batch] Completed batch ${batchId}`);
    return job;
  }

  private async updateJobState(batchId: string, job: BatchJob): Promise<void> {
    const client = await getValkeyClient();
    await client.hset(`${this.prefix}:${batchId}`, [{ field: 'data', value: JSON.stringify(job) }]);
  }

  async getBatchStatus(batchId: string): Promise<BatchJob | null> {
    const client = await getValkeyClient();
    const jobData = await client.hget(`${this.prefix}:${batchId}`, 'data');
    
    if (!jobData) return null;
    return JSON.parse(jobData.toString()) as BatchJob;
  }

  async listActiveBatches(): Promise<string[]> {
    const client = await getValkeyClient();
    const members = await client.smembers(`${this.prefix}:active`);
    return Array.from(members).map(m => m.toString());
  }

  async cancelBatch(batchId: string): Promise<boolean> {
    const client = await getValkeyClient();
    const exists = await client.exists([`${this.prefix}:${batchId}`]);
    
    if (!exists) return false;

    await client.srem(`${this.prefix}:active`, [batchId]);
    await client.sadd(`${this.prefix}:cancelled`, [batchId]);
    
    const jobData = await client.hget(`${this.prefix}:${batchId}`, 'data');
    if (jobData) {
      const job = JSON.parse(jobData.toString()) as BatchJob;
      job.status = 'failed';
      await this.updateJobState(batchId, job);
    }

    console.log(`[Batch] Cancelled batch ${batchId}`);
    return true;
  }
}
