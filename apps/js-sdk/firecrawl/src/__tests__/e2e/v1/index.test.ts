import FirecrawlApp, { type CrawlParams, type CrawlResponse, type CrawlStatusResponse, type MapResponse, type ScrapeResponse } from '../../../index';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { describe, test, expect } from '@jest/globals';

dotenv.config();

const TEST_API_KEY = process.env.TEST_API_KEY;
const API_URL = process.env.API_URL ?? "https://api.firecrawl.dev";

describe('FirecrawlApp E2E Tests', () => {
  test.concurrent('should throw error for no API key only for cloud service', async () => {
    if (API_URL.includes('api.firecrawl.dev')) {
      // Should throw for cloud service
      expect(() => {
        new FirecrawlApp({ apiKey: null, apiUrl: API_URL });
      }).toThrow("No API key provided");
    } else {
      // Should not throw for self-hosted
      expect(() => {
        new FirecrawlApp({ apiKey: null, apiUrl: API_URL });
      }).not.toThrow();
    }
  });

  test.concurrent('should throw error for invalid API key on scrape', async () => {
    if (API_URL.includes('api.firecrawl.dev')) {
      const invalidApp = new FirecrawlApp({ apiKey: "invalid_api_key", apiUrl: API_URL });
      await expect(invalidApp.scrapeUrl('https://roastmywebsite.ai')).rejects.toThrow("Unexpected error occurred while trying to scrape URL. Status code: 401");
    } else {
      const invalidApp = new FirecrawlApp({ apiKey: "invalid_api_key", apiUrl: API_URL });
      await expect(invalidApp.scrapeUrl('https://roastmywebsite.ai')).resolves.not.toThrow();
    }
  });

  test.concurrent('should throw error for blocklisted URL on scrape', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const blocklistedUrl = "https://facebook.com/fake-test";
    await expect(app.scrapeUrl(blocklistedUrl)).rejects.toThrow("This website is not currently supported");
  });

  test.concurrent('should return successful response for valid scrape', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });

    const response = await app.scrapeUrl('https://roastmywebsite.ai');
    if (!response.success) {
      throw new Error(response.error);
    }
  }, 30000); // 30 seconds timeout

  test.concurrent('should return successful response with valid API key and options', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.scrapeUrl(
      'https://roastmywebsite.ai', {
      formats: ['markdown', 'html', 'rawHtml', 'screenshot', 'links'],
      headers: { "x-key": "test" },
      includeTags: ['h1'],
      excludeTags: ['h2'],
      onlyMainContent: true,
      timeout: 30000,
      waitFor: 1000
    });

    if (!response.success) {
      throw new Error(response.error);
    }
  }, 30000); // 30 seconds timeout

  test.concurrent('should return successful response with valid API key and screenshot fullPage', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.scrapeUrl(
      'https://roastmywebsite.ai', {
      formats: ['screenshot@fullPage'],
    });
    if (!response.success) {
      throw new Error(response.error);
    }

    expect(response.screenshot).not.toBeUndefined();
    expect(response.screenshot).not.toBeNull();
    expect(response.screenshot).toContain("https://");
  }, 30000); // 30 seconds timeout

  test.concurrent('should return successful response for valid scrape with PDF file', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.scrapeUrl('https://arxiv.org/pdf/astro-ph/9301001.pdf');
    if (!response.success) {
      throw new Error(response.error);
    }

    expect(response).not.toBeNull();
    expect(response?.markdown).toContain('We present spectrophotometric observations of the Broad Line Radio Galaxy');
  }, 30000); // 30 seconds timeout

  test.concurrent('should return successful response for valid scrape with PDF file without explicit extension', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.scrapeUrl('https://arxiv.org/pdf/astro-ph/9301001');
    if (!response.success) {
      throw new Error(response.error);
    }

    expect(response).not.toBeNull();
    expect(response?.markdown).toContain('We present spectrophotometric observations of the Broad Line Radio Galaxy');
  }, 30000); // 30 seconds timeout

  test.concurrent('should return successful response for valid scrape with PDF file and parsePDF true', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.scrapeUrl('https://arxiv.org/pdf/astro-ph/9301001.pdf', {
      parsePDF: true
    });
    if (!response.success) {
      throw new Error(response.error);
    }

    expect(response).not.toBeNull();
    expect(response?.markdown).toContain('We present spectrophotometric observations of the Broad Line Radio Galaxy');
  }, 30000); // 30 seconds timeout

  test.concurrent('should return successful response for valid scrape with PDF file and parsePDF false', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.scrapeUrl('https://arxiv.org/pdf/astro-ph/9301001.pdf', {
      parsePDF: false
    });
    if (!response.success) {
      throw new Error(response.error);
    }

    expect(response).not.toBeNull();
    expect(response?.markdown).toMatch(/^[A-Za-z0-9+/]+=*$/);
  }, 30000); // 30 seconds timeout

  test.concurrent('should throw error for invalid API key on crawl', async () => {
    if (API_URL.includes('api.firecrawl.dev')) {
      const invalidApp = new FirecrawlApp({ apiKey: "invalid_api_key", apiUrl: API_URL });
      await expect(invalidApp.crawlUrl('https://roastmywebsite.ai')).rejects.toThrow("Request failed with status code 401");
    } else {
      const invalidApp = new FirecrawlApp({ apiKey: "invalid_api_key", apiUrl: API_URL });
      await expect(invalidApp.crawlUrl('https://roastmywebsite.ai')).resolves.not.toThrow();
    }
  });

  test.concurrent('should return successful response for crawl and wait for completion', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.crawlUrl('https://roastmywebsite.ai', {}, 30) as CrawlStatusResponse;
    expect(response).not.toHaveProperty("next"); // wait until done
    expect(response.data.length).toBeGreaterThan(0);
    if (response.data[0]) {
      expect(response.data[0]).toHaveProperty("markdown");
    }
  }, 60000); // 60 seconds timeout

  test.concurrent('should return successful response for crawl with options and wait for completion', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.crawlUrl('https://roastmywebsite.ai', {
      excludePaths: ['blog/*'],
      includePaths: ['/'],
      maxDepth: 2,
      ignoreSitemap: true,
      limit: 10,
      allowBackwardLinks: true,
      allowExternalLinks: true,
      scrapeOptions: {
        formats: ['markdown', 'html', 'rawHtml', 'screenshot', 'links'],
        headers: { "x-key": "test" },
        includeTags: ['h1'],
        excludeTags: ['h2'],
        onlyMainContent: true,
        waitFor: 1000
      }
    } as CrawlParams, 30) as CrawlStatusResponse;
    expect(response).not.toHaveProperty("next");
    expect(response.data.length).toBeGreaterThan(0);
    if (response.data[0]) {
      expect(response.data[0]).toHaveProperty("markdown");
      expect(response.data[0]).not.toHaveProperty('content'); // v0
      expect(response.data[0]).toHaveProperty("html");
      expect(response.data[0]).toHaveProperty("rawHtml");
      expect(response.data[0]).toHaveProperty("screenshot");
      expect(response.data[0]).toHaveProperty("links");
    }
  }, 60000); // 60 seconds timeout

  test.concurrent('should handle idempotency key for crawl', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const uniqueIdempotencyKey = uuidv4();
    const response = await app.asyncCrawlUrl('https://roastmywebsite.ai', {}, uniqueIdempotencyKey) as CrawlResponse;
    expect(response).not.toBeNull();
    expect(response.id).toBeDefined();

    await expect(app.crawlUrl('https://roastmywebsite.ai', {}, 2, uniqueIdempotencyKey)).rejects.toThrow("Request failed with status code 409");
  });

  test.concurrent('should check crawl status', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const response = await app.asyncCrawlUrl('https://firecrawl.dev', { limit: 20, scrapeOptions: { formats: ['markdown', 'html', 'rawHtml', 'screenshot', 'links'] } } as CrawlParams) as CrawlResponse;
    expect(response).not.toBeNull();
    expect(response.id).toBeDefined();

    let statusResponse = await app.checkCrawlStatus(response.id);
    const maxChecks = 15;
    let checks = 0;

    expect(statusResponse.success).toBe(true);
    while ((statusResponse as any).status === 'scraping' && checks < maxChecks) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      expect(statusResponse).not.toHaveProperty("partial_data"); // v0
      expect(statusResponse).not.toHaveProperty("current"); // v0
      expect(statusResponse).toHaveProperty("data");
      expect(statusResponse).toHaveProperty("total");
      expect(statusResponse).toHaveProperty("creditsUsed");
      expect(statusResponse).toHaveProperty("expiresAt");
      expect(statusResponse).toHaveProperty("status");
      expect(statusResponse).toHaveProperty("next");
      expect(statusResponse.success).toBe(true);
      if (statusResponse.success === true) {
        expect(statusResponse.total).toBeGreaterThan(0);
        expect(statusResponse.creditsUsed).toBeGreaterThan(0);
        expect(statusResponse.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(statusResponse.status).toBe("scraping");
        expect(statusResponse.next).toContain("/v1/crawl/");
      }
      statusResponse = await app.checkCrawlStatus(response.id) as CrawlStatusResponse;
      expect(statusResponse.success).toBe(true);
      checks++;
    }

    expect(statusResponse).not.toBeNull();
    expect(statusResponse).toHaveProperty("total");
    expect(statusResponse.success).toBe(true);
    if (statusResponse.success === true) {
      expect(statusResponse.status).toBe("completed");
      expect(statusResponse.data.length).toBeGreaterThan(0);
    }
  }, 60000); // 60 seconds timeout

  test.concurrent('should throw error for invalid API key on map', async () => {
    if (API_URL.includes('api.firecrawl.dev')) {
      const invalidApp = new FirecrawlApp({ apiKey: "invalid_api_key", apiUrl: API_URL });
      await expect(invalidApp.mapUrl('https://roastmywebsite.ai')).rejects.toThrow("Request failed with status code 401");
    } else {
      const invalidApp = new FirecrawlApp({ apiKey: "invalid_api_key", apiUrl: API_URL });
      await expect(invalidApp.mapUrl('https://roastmywebsite.ai')).resolves.not.toThrow();
    }
  });

  test.concurrent('should throw error for blocklisted URL on map', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL });
    const blocklistedUrl = "https://facebook.com/fake-test";
    await expect(app.mapUrl(blocklistedUrl)).rejects.toThrow("403");
  });

  test.concurrent('should return successful response for valid map', async () => {
    const app = new FirecrawlApp({ apiKey: TEST_API_KEY, apiUrl: API_URL }); const response = await app.mapUrl('https://roastmywebsite.ai') as MapResponse;
    expect(response).not.toBeNull();

    expect(response.links?.length).toBeGreaterThan(0);
    expect(response.links?.[0]).toContain("https://");
    const filteredLinks = response.links?.filter((link: string) => link.includes("roastmywebsite.ai"));
    expect(filteredLinks?.length).toBeGreaterThan(0);
  }, 30000); // 30 seconds timeout



  test('should search with string query', async () => {
    const app = new FirecrawlApp({ apiUrl: API_URL, apiKey: TEST_API_KEY });
    const response = await app.search("firecrawl");
    expect(response.success).toBe(true);
    expect(response.data?.length).toBeGreaterThan(0);
    expect(response.data?.[0]?.markdown).not.toBeDefined();
    expect(response.data?.[0]?.title).toBeDefined();
    expect(response.data?.[0]?.description).toBeDefined();
  }, 30000); // 30 seconds timeout

  test('should search with params object', async () => {
    const app = new FirecrawlApp({ apiUrl: API_URL, apiKey: TEST_API_KEY });
    const response = await app.search("firecrawl", {
      limit: 3,
      lang: 'en',
      country: 'us',
      scrapeOptions: {
        formats: ['markdown', 'html', 'links'],
        onlyMainContent: true
      }
    });
    expect(response.success).toBe(true);
    expect(response.data.length).toBeLessThanOrEqual(3);
    for (const doc of response.data) {
      expect(doc.markdown).toBeDefined();
      expect(doc.html).toBeDefined();
      expect(doc.links).toBeDefined();
      expect(doc.title).toBeDefined();
      expect(doc.description).toBeDefined();
    }
  }, 30000); // 30 seconds timeout

  test('should handle invalid API key for search', async () => {
    const app = new FirecrawlApp({ apiUrl: API_URL, apiKey: "invalid_api_key" });
    await expect(app.search("test query")).rejects.toThrow("Request failed with status code 401");
  });

});
