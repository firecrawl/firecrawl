import axios, { AxiosInstance } from 'axios';
import { config } from './config';

export interface ScrapeResult {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

export interface CrawlResult {
  success: boolean;
  id?: string;
  status?: string;
  data?: Array<{
    markdown?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }>;
  error?: string;
}

export class FirecrawlClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.firecrawl.apiUrl,
      headers: {
        'Authorization': `Bearer ${config.firecrawl.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });
  }

  async scrape(url: string, options: Record<string, unknown> = {}): Promise<ScrapeResult> {
    try {
      const response = await this.client.post('/v1/scrape', { url, ...options });
      return { success: true, data: response.data.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async crawl(url: string, options: Record<string, unknown> = {}): Promise<CrawlResult> {
    try {
      const response = await this.client.post('/v1/crawl', { url, ...options });
      return { success: true, id: response.data.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async getCrawlStatus(crawlId: string): Promise<CrawlResult> {
    try {
      const response = await this.client.get(`/v1/crawl/${crawlId}`);
      return { success: true, ...response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async cancelCrawl(crawlId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.delete(`/v1/crawl/${crawlId}`);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}
