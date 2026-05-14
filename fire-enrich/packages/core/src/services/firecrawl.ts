import FirecrawlApp from '@mendable/firecrawl-js';
import type { SearchResult } from '../types/index.js';

export class FirecrawlService {
  private app: FirecrawlApp;

  constructor(apiKey: string) {
    this.app = new FirecrawlApp({ apiKey, apiUrl: process.env.FIRECRAWL_API_URL });
  }

  async search(
    query: string,
    options: {
      limit?: number;
      scrapeContent?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { limit = 5, scrapeContent = true } = options;

        const searchOptions: Record<string, unknown> = { limit };
        
        if (scrapeContent) {
          searchOptions.scrapeOptions = {
            formats: ['markdown', 'links', 'html'],
          };
        }

        const result = await this.app.v1.search(query, searchOptions);

        return (result.data || []).map((item) => ({
          url: item.url || '',
          title: item.title || '',
          description: item.description || '',
          markdown: item.markdown,
          html: item.html,
          links: item.links,
          metadata: item.metadata,
        }));
      } catch (error) {
        const errorWithStatus = error as { statusCode?: number; message?: string };
        const isRetryableError = 
          errorWithStatus?.statusCode === 502 || 
          errorWithStatus?.statusCode === 503 || 
          errorWithStatus?.statusCode === 504 ||
          errorWithStatus?.statusCode === 429;
        
        if (isRetryableError && attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.warn(`Firecrawl search failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`);
          console.warn('Error:', errorWithStatus?.statusCode || errorWithStatus?.message);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        console.error('Firecrawl search error:', error);
        console.error('Query:', query);
        
        // Return empty results instead of throwing
        // This allows enrichment to continue with other data sources
        return [];
      }
    }
    
    return [];
  }

  async searchWithMultipleQueries(
    queries: string[],
    options: {
      limit?: number;
      scrapeContent?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];
    const seen = new Set<string>();

    for (const query of queries) {
      try {
        const results = await this.search(query, options);
        
        for (const result of results) {
          if (!seen.has(result.url)) {
            seen.add(result.url);
            allResults.push(result);
          }
        }
      } catch (error) {
        // Log but continue with other queries
        console.error(`Failed to search for query "${query}":`, error);
      }
    }

    return allResults;
  }

  async scrapeUrl(url: string): Promise<{ data?: { markdown?: string; html?: string }; error?: string }> {
    const maxRetries = 3;
    const baseDelay = 1000;
    
    // Ensure URL has protocol
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // First try with normal TLS verification
        const result = await this.app.v1.scrapeUrl(fullUrl, {
          formats: ['markdown', 'html'],
          timeout: 30000, // 30 second timeout
        });

        return result;
      } catch (error) {
        // Check if it's an SSL error
        const errorWithMessage = error as { message?: string; statusCode?: number };
        const isSSLError = errorWithMessage?.message?.includes('SSL error') || 
                          errorWithMessage?.message?.includes('certificate') ||
                          errorWithMessage?.statusCode === 500 && errorWithMessage?.message?.includes('SSL');
        
        // If SSL error, retry with skipTlsVerification
        if (isSSLError && attempt === 0) {
          try {
            console.warn(`SSL error for ${fullUrl}, retrying with skipTlsVerification...`);
            const result = await this.app.v1.scrapeUrl(fullUrl, {
              formats: ['markdown', 'html'],
              skipTlsVerification: true,
              timeout: 30000,
            });
            return result;
          } catch (retryError) {
            // Continue to normal retry logic
            error = retryError;
          }
        }
        
        const isRetryableError = 
          errorWithMessage?.statusCode === 502 || 
          errorWithMessage?.statusCode === 503 || 
          errorWithMessage?.statusCode === 504 ||
          errorWithMessage?.statusCode === 429 ||
          errorWithMessage?.message?.includes('network error') ||
          errorWithMessage?.message?.includes('server is unreachable');
        
        if (isRetryableError && attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.warn(`Firecrawl scrape failed for ${fullUrl} (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`);
          console.warn('Error:', errorWithMessage?.statusCode || errorWithMessage?.message);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Re-throw the error to be caught by the calling code
        throw error;
      }
    }
    
    throw new Error(`Failed to scrape ${fullUrl} after ${maxRetries} attempts`);
  }

  // ---------- v4 surface (Phase 5) ----------
  // These call the v4 top-level methods on the SDK directly, not via .v1.
  // Return shapes are normalised into the plain JSON our routes expose.

  /**
   * Kick off an async crawl. Returns the job id; poll with `getCrawlStatus`.
   */
  async startCrawl(
    url: string,
    options?: Record<string, unknown>,
  ): Promise<{ jobId: string }> {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    const res = await this.app.startCrawl(fullUrl, options as never);
    const jobId = (res as { id?: string }).id;
    if (!jobId) {
      throw new Error('Firecrawl startCrawl returned no job id');
    }
    return { jobId };
  }

  /**
   * Fetch current status of a crawl job. Pass-through of SDK shape.
   */
  async getCrawlStatus(jobId: string): Promise<unknown> {
    return this.app.getCrawlStatus(jobId);
  }

  /**
   * Cancel a running crawl. Wraps the SDK's boolean response.
   */
  async cancelCrawl(jobId: string): Promise<{ ok: boolean }> {
    const ok = await this.app.cancelCrawl(jobId);
    return { ok: Boolean(ok) };
  }

  /**
   * Map a website's URL graph into a flat list of links.
   */
  async mapUrl(
    url: string,
    options?: Record<string, unknown>,
  ): Promise<{ links: string[] }> {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    const result = await this.app.map(fullUrl, options as never);
    const links = (result as { links?: unknown[] }).links;
    return {
      links: Array.isArray(links)
        ? (links as unknown[])
            .map((l) => (typeof l === 'string' ? l : (l as { url?: string }).url ?? ''))
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [],
    };
  }

  /**
   * Structured extraction. Accepts urls + prompt and/or schema.
   * Schema can be a Zod schema or a plain object descriptor — passed
   * through to the SDK as-is.
   */
  async extract(args: {
    urls: string[];
    prompt?: string;
    schema?: unknown;
    showSources?: boolean;
  }): Promise<unknown> {
    return this.app.extract(args as never);
  }

  /**
   * Start an async batch scrape. Poll with `getBatchScrapeStatus`.
   */
  async startBatchScrape(
    urls: string[],
    options?: Record<string, unknown>,
  ): Promise<{ jobId: string }> {
    const res = await this.app.startBatchScrape(urls, options as never);
    const jobId = (res as { id?: string }).id;
    if (!jobId) {
      throw new Error('Firecrawl startBatchScrape returned no job id');
    }
    return { jobId };
  }

  async getBatchScrapeStatus(jobId: string): Promise<unknown> {
    return this.app.getBatchScrapeStatus(jobId);
  }
}