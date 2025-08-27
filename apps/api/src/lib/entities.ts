import type { Document as V1Document, Action } from "../controllers/v1/types";

export interface Progress {
  current: number;
  total: number;
  status: string;
  metadata?: {
    sourceURL?: string;
    [key: string]: any;
  };
  currentDocumentUrl?: string;
  currentDocument?: Document;
}

export type PageOptions = {
  includeMarkdown?: boolean;
  includeExtract?: boolean;
  onlyMainContent?: boolean;
  includeHtml?: boolean;
  includeRawHtml?: boolean;
  fallback?: boolean;
  fetchPageContent?: boolean;
  waitFor?: number;
  screenshot?: boolean;
  fullPageScreenshot?: boolean;
  headers?: Record<string, string>;
  replaceAllPathsWithAbsolutePaths?: boolean;
  parsePDF?: boolean;
  removeTags?: string | string[];
  onlyIncludeTags?: string | string[];
  includeLinks?: boolean;
  useFastMode?: boolean; // beta
  disableJsDom?: boolean; // beta
  atsv?: boolean; // anti-bot solver, beta
  actions?: Action[]; // beta
  geolocation?: {
    country?: string;
  };
  skipTlsVerification?: boolean;
  removeBase64Images?: boolean;
  mobile?: boolean;
};

export type ExtractorOptions = {
  mode:
    | "markdown"
    | "llm-extraction"
    | "llm-extraction-from-markdown"
    | "llm-extraction-from-raw-html";
  extractionPrompt?: string;
  extractionSchema?: Record<string, any>;
  userPrompt?: string;
};

export type SearchOptions = {
  limit?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
};

export type CrawlerOptions = {
  returnOnlyUrls?: boolean;
  includes?: string | string[];
  excludes?: string | string[];
  maxCrawledLinks?: number;
  maxDepth?: number;
  limit?: number;
  generateImgAltText?: boolean;
  replaceAllPathsWithAbsolutePaths?: boolean;
  ignoreSitemap?: boolean;
  mode?: "default" | "fast"; // have a mode of some sort
  allowBackwardCrawling?: boolean;
  allowExternalContentLinks?: boolean;
};

export type WebScraperOptions = {
  jobId: string;
  urls: string[];
  mode: "single_urls" | "sitemap" | "crawl";
  crawlerOptions?: CrawlerOptions;
  pageOptions?: PageOptions;
  extractorOptions?: ExtractorOptions;
  concurrentRequests?: number;
  bullJobId?: string;
  priority?: number;
  teamId?: string;
};

export interface DocumentUrl {
  url: string;
}

export class Document {
  id?: string;
  url?: string; // Used only in /search for now
  content: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  llm_extraction?: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
  type?: string;
  metadata: {
    sourceURL?: string;
    [key: string]: any;
  };
  childrenLinks?: string[];
  provider?: string;
  warning?: string;
  actions?: {
    screenshots?: string[];
    scrapes?: ScrapeActionContent[];
  };

  index?: number;
  linksOnPage?: string[]; // Add this new field as a separate property

  constructor(data: Partial<Document>) {
    if (!data.content) {
      throw new Error("Missing required fields");
    }
    this.content = data.content;
    this.createdAt = data.createdAt || new Date();
    this.updatedAt = data.updatedAt || new Date();
    this.type = data.type || "unknown";
    this.metadata = data.metadata || { sourceURL: "" };
    this.markdown = data.markdown || "";
    this.childrenLinks = data.childrenLinks || undefined;
    this.provider = data.provider || undefined;
    this.linksOnPage = data.linksOnPage; // Assign linksOnPage if provided
  }
}

export class SearchResult {
  url: string;
  title: string;
  description: string;

  constructor(url: string, title: string, description: string) {
    this.url = url;
    this.title = title;
    this.description = description;
  }

  toString(): string {
    return `SearchResult(url=${this.url}, title=${this.title}, description=${this.description})`;
  }
}

export interface ImageSearchResult {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  url?: string;
  position?: number;
}

export interface NewsSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  imageUrl?: string;
  position?: number;
  category?: string;
  // Scraped content fields
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  metadata?: Record<string, any>;
}

export interface WebSearchResult {
  url: string;
  title: string;
  description: string;
  position?: number;
  category?: string;
  // Scraped content fields
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  metadata?: Record<string, any>;
}

export type SearchResultType = 'web' | 'images' | 'news';

export interface SearchV2Response {
  web?: WebSearchResult[];
  images?: ImageSearchResult[];
  news?: NewsSearchResult[];
}

export interface ScrapeActionContent {
  url: string;
  html: string;
}

export interface FireEngineResponse {
  html: string;
  screenshots?: string[];
  pageStatusCode?: number;
  pageError?: string;
  scrapeActionContent?: ScrapeActionContent[];
}

export interface FireEngineOptions {
  mobileProxy?: boolean;
  method?: string;
  engine?: string;
  blockMedia?: boolean;
  blockAds?: boolean;
  disableJsDom?: boolean;
  atsv?: boolean; // beta
}
