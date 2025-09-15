import FirecrawlApp from "@mendable/firecrawl-js";

export const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY || 'your-api-key-here',
});

export interface ScrapeResult {
  success: boolean;
  data?: {
    title?: string;
    content?: string;
    markdown?: string;
    html?: string;
    metadata?: any;
  };
  error?: string;
}

export interface CrawlResult {
  success: boolean;
  data?: {
    pages: Array<{
      url: string;
      title?: string;
      content?: string;
      markdown?: string;
      html?: string;
      metadata?: any;
    }>;
    totalPages: number;
  };
  error?: string;
}

export async function scrapeUrl(
  url: string,
  options: {
    includeHtml?: boolean;
    includeMarkdown?: boolean;
    onlyMainContent?: boolean;
  } = {}
): Promise<ScrapeResult> {
  try {
    const scrapeResult = await firecrawl.scrape(url, {
      formats: options.includeMarkdown ? ['markdown'] : [],
      onlyMainContent: options.onlyMainContent ?? true,
    });

    return {
      success: true,
      data: {
        title: scrapeResult.metadata?.title,
        content: scrapeResult.markdown || '',
        markdown: scrapeResult.markdown,
        html: options.includeHtml ? scrapeResult.html : undefined,
        metadata: scrapeResult.metadata,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

export async function crawlUrl(
  baseUrl: string,
  options: {
    maxPages?: number;
    allowExternalLinks?: boolean;
    includeHtml?: boolean;
    includeMarkdown?: boolean;
    onlyMainContent?: boolean;
  } = {}
): Promise<CrawlResult> {
  try {
    const crawlResult = await firecrawl.crawl(baseUrl, {
      limit: options.maxPages ?? 10,
      allowExternalLinks: options.allowExternalLinks ?? false,
      scrapeOptions: {
        formats: options.includeMarkdown ? ['markdown'] : [],
        onlyMainContent: options.onlyMainContent ?? true,
      },
    });

    const pages = crawlResult.data.map((page: any) => ({
      url: page.url || '',
      title: page.metadata?.title,
      content: page.markdown || '',
      markdown: page.markdown,
      html: options.includeHtml ? page.html : undefined,
      metadata: page.metadata,
    }));

    return {
      success: true,
      data: {
        pages,
        totalPages: pages.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}
