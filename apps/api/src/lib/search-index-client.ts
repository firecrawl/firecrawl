/**
 * HTTP Client for Search Index Service
 * 
 * This client communicates with the standalone search index service
 * (firecrawl-search backend) via HTTP.
 */

import { logger as _logger } from "./logger";
import type { Logger } from "winston";

export interface SearchIndexClientConfig {
  baseUrl: string;
  apiSecret?: string;
  timeout?: number;
}

export interface IndexDocumentRequest {
  url: string;
  resolvedUrl: string;
  title?: string;
  description?: string;
  markdown: string;
  html: string;
  statusCode: number;
  gcsPath?: string;
  screenshotUrl?: string;
  language?: string;
  country?: string;
  isMobile?: boolean;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  offset?: number;
  mode?: "hybrid" | "keyword" | "semantic" | "bm25";
  filters?: {
    domain?: string;
    country?: string;
    isMobile?: boolean;
    minFreshness?: number;
    language?: string;
  };
}

export interface SearchResult {
  documentId: string;
  url: string;
  title: string | null;
  description: string | null;
  domain: string;
  snippet?: string;
  score: number;
  bm25Rank: number | null;
  vectorRank: number | null;
  freshnessScore: number;
  qualityScore: number;
  lastCrawledAt: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
  mode: string;
  took: number;
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export class SearchIndexClient {
  private baseUrl: string;
  private apiSecret?: string;
  private timeout: number;
  
  constructor(config: SearchIndexClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.apiSecret = config.apiSecret;
    this.timeout = config.timeout || 30000;
  }
  
  /**
   * Check if search index service is enabled
   */
  static isEnabled(): boolean {
    return !!(
      process.env.SEARCH_SERVICE_URL &&
      process.env.ENABLE_SEARCH_INDEX === "true"
    );
  }
  
  /**
   * Make HTTP request to search service
   */
  private async request<T>(
    method: string,
    path: string,
    body?: any,
    logger?: Logger,
  ): Promise<T> {
    const log = logger ?? _logger.child({ module: "search-index-client" });
    const url = `${this.baseUrl}${path}`;
    
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    
    if (this.apiSecret) {
      headers["X-API-Secret"] = this.apiSecret;
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      log.debug("Making request to search service", {
        method,
        url,
        hasBody: !!body,
      });
      
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      const data = await response.json();
      
      if (!response.ok) {
        log.error("Search service request failed", {
          status: response.status,
          error: data.error || "Unknown error",
        });
        throw new Error(
          data.error || `Search service returned ${response.status}`,
        );
      }
      
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === "AbortError") {
        log.error("Search service request timed out", { url, timeout: this.timeout });
        throw new Error("Search service request timed out");
      }
      
      log.error("Search service request failed", {
        error: (error as Error).message,
        url,
      });
      throw error;
    }
  }
  
  /**
   * Index a document (async - queues for processing)
   */
  async indexDocument(
    request: IndexDocumentRequest,
    logger?: Logger,
  ): Promise<{ success: boolean; message: string }> {
    const log = logger ?? _logger.child({ module: "search-index-client" });
    
    try {
      const response = await this.request<any>(
        "POST",
        "/api/index",
        request,
        log,
      );
      
      log.info("Document queued for indexing", {
        url: request.url,
        success: response.success,
      });
      
      return {
        success: response.success,
        message: response.message || "Document queued for indexing",
      };
    } catch (error) {
      log.error("Failed to queue document for indexing", {
        error: (error as Error).message,
        url: request.url,
      });
      
      // Don't throw - indexing failures shouldn't break scraping
      return {
        success: false,
        message: (error as Error).message,
      };
    }
  }
  
  /**
   * Search indexed documents
   */
  async search(
    request: SearchRequest,
    logger?: Logger,
  ): Promise<SearchResponse> {
    const log = logger ?? _logger.child({ module: "search-index-client" });
    
    try {
      const response = await this.request<{ success: boolean; data: SearchResponse }>(
        "POST",
        "/api/search",
        request,
        log,
      );
      
      if (!response.success || !response.data) {
        throw new Error("Invalid response from search service");
      }
      
      log.info("Search completed", {
        query: request.query,
        results: response.data.results.length,
        took: response.data.took,
      });
      
      return response.data;
    } catch (error) {
      log.error("Search request failed", {
        error: (error as Error).message,
        query: request.query,
      });
      
      // Return empty results on error
      return {
        results: [],
        total: 0,
        query: request.query,
        mode: request.mode || "hybrid",
        took: 0,
        pagination: {
          limit: request.limit || 50,
          offset: request.offset || 0,
          hasMore: false,
        },
      };
    }
  }
  
  /**
   * Get search index statistics
   */
  async getStats(logger?: Logger): Promise<{
    index: any;
    queue: any;
  }> {
    const log = logger ?? _logger.child({ module: "search-index-client" });
    
    try {
      const response = await this.request<{ success: boolean; data: any }>(
        "GET",
        "/api/stats",
        undefined,
        log,
      );
      
      if (!response.success || !response.data) {
        throw new Error("Invalid response from search service");
      }
      
      return response.data;
    } catch (error) {
      log.error("Failed to get search stats", {
        error: (error as Error).message,
      });
      
      return {
        index: {},
        queue: {},
      };
    }
  }
  
  /**
   * Health check
   */
  async health(logger?: Logger): Promise<boolean> {
    const log = logger ?? _logger.child({ module: "search-index-client" });
    
    try {
      const response = await this.request<{ success: boolean }>(
        "GET",
        "/health",
        undefined,
        log,
      );
      
      return response.success;
    } catch (error) {
      log.warn("Search service health check failed", {
        error: (error as Error).message,
      });
      return false;
    }
  }
}

// Singleton instance
let searchIndexClient: SearchIndexClient | null = null;

/**
 * Get search index client instance
 */
export function getSearchIndexClient(): SearchIndexClient | null {
  if (!SearchIndexClient.isEnabled()) {
    return null;
  }
  
  if (!searchIndexClient) {
    const baseUrl = process.env.SEARCH_SERVICE_URL!;
    const apiSecret = process.env.SEARCH_SERVICE_API_SECRET;
    
    searchIndexClient = new SearchIndexClient({
      baseUrl,
      apiSecret,
      timeout: 30000,
    });
    
    _logger.info("Search index client initialized", {
      baseUrl: baseUrl.substring(0, 30) + "...",
    });
  }
  
  return searchIndexClient;
}

/**
 * Helper: Index document if search service is enabled
 */
export async function indexDocumentIfEnabled(
  request: IndexDocumentRequest,
  logger?: Logger,
): Promise<void> {
  const client = getSearchIndexClient();
  
  if (!client) {
    return;
  }
  
  try {
    await client.indexDocument(request, logger);
  } catch (error) {
    // Silently fail - indexing is optional
    (logger ?? _logger).warn("Failed to index document", {
      error: (error as Error).message,
      url: request.url,
    });
  }
}

