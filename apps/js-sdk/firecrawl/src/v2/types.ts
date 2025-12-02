import type { ZodTypeAny } from 'zod';
// Public types for Firecrawl JS/TS SDK v2 (camelCase only)

export type FormatString =
  | 'markdown'
  | 'html'
  | 'rawHtml'
  | 'links'
  | 'images'
  | 'screenshot'
  | 'summary'
  | 'changeTracking'
  | 'json'
  | 'attributes'
  | 'branding';

export interface Viewport {
  width: number;
  height: number;
}

export interface Format {
  type: FormatString;
}

export interface JsonFormat extends Format {
  type: 'json';
  prompt?: string;
  schema?: Record<string, unknown> | ZodTypeAny;
}

export interface ScreenshotFormat {
  type: 'screenshot';
  fullPage?: boolean;
  quality?: number;
  viewport?: Viewport | { width: number; height: number };
}

export interface ChangeTrackingFormat extends Format {
  type: 'changeTracking';
  modes: ('git-diff' | 'json')[];
  schema?: Record<string, unknown>;
  prompt?: string;
  tag?: string;
}
export interface AttributesFormat extends Format {
  type: 'attributes';
  selectors: Array<{
    selector: string;
    attribute: string;
  }>;
}

export type FormatOption =
  | FormatString
  | Format
  | JsonFormat
  | ChangeTrackingFormat
  | ScreenshotFormat
  | AttributesFormat;

export interface LocationConfig {
  country?: string;
  languages?: string[];
}

export interface WaitAction {
  type: 'wait';
  milliseconds?: number;
  selector?: string;
}

export interface ScreenshotAction {
  type: 'screenshot';
  fullPage?: boolean;
  quality?: number;
  viewport?: Viewport | { width: number; height: number };
}

export interface ClickAction {
  type: 'click';
  selector: string;
}

export interface WriteAction {
  type: 'write';
  text: string;
}

export interface PressAction {
  type: 'press';
  key: string;
}

export interface ScrollAction {
  type: 'scroll';
  direction: 'up' | 'down';
  selector?: string;
}

export interface ScrapeAction {
  type: 'scrape';
}

export interface ExecuteJavascriptAction {
  type: 'executeJavascript';
  script: string;
}

export interface PDFAction {
  type: 'pdf';
  format?:
    | 'A0'
    | 'A1'
    | 'A2'
    | 'A3'
    | 'A4'
    | 'A5'
    | 'A6'
    | 'Letter'
    | 'Legal'
    | 'Tabloid'
    | 'Ledger';
  landscape?: boolean;
  scale?: number;
}

export type ActionOption =
  | WaitAction
  | ScreenshotAction
  | ClickAction
  | WriteAction
  | PressAction
  | ScrollAction
  | ScrapeAction
  | ExecuteJavascriptAction
  | PDFAction;

export interface ScrapeOptions {
  formats?: FormatOption[];
  headers?: Record<string, string>;
  includeTags?: string[];
  excludeTags?: string[];
  onlyMainContent?: boolean;
  timeout?: number;
  waitFor?: number;
  mobile?: boolean;
  parsers?: Array<string | { type: 'pdf'; maxPages?: number }>;
  actions?: ActionOption[];
  location?: LocationConfig;
  skipTlsVerification?: boolean;
  removeBase64Images?: boolean;
  fastMode?: boolean;
  useMock?: string;
  blockAds?: boolean;
  proxy?: 'basic' | 'stealth' | 'auto' | string;
  maxAge?: number;
  minAge?: number;
  storeInCache?: boolean;
  integration?: string;
}

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  events?: Array<'completed' | 'failed' | 'page' | 'started'>;
}

export interface BrandingProfile {
  colorScheme?: 'light' | 'dark';
  logo?: string | null;
  fonts?: Array<{
    family: string;
    [key: string]: unknown;
  }>;
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    textPrimary?: string;
    textSecondary?: string;
    link?: string;
    success?: string;
    warning?: string;
    error?: string;
    [key: string]: string | undefined;
  };
  typography?: {
    fontFamilies?: {
      primary?: string;
      heading?: string;
      code?: string;
      [key: string]: string | undefined;
    };
    fontStacks?: {
      primary?: string[];
      heading?: string[];
      body?: string[];
      paragraph?: string[];
      [key: string]: string[] | undefined;
    };
    fontSizes?: {
      h1?: string;
      h2?: string;
      h3?: string;
      body?: string;
      small?: string;
      [key: string]: string | undefined;
    };
    lineHeights?: {
      heading?: number;
      body?: number;
      [key: string]: number | undefined;
    };
    fontWeights?: {
      light?: number;
      regular?: number;
      medium?: number;
      bold?: number;
      [key: string]: number | undefined;
    };
  };
  spacing?: {
    baseUnit?: number;
    padding?: Record<string, number>;
    margins?: Record<string, number>;
    gridGutter?: number;
    borderRadius?: string;
    [key: string]: number | string | Record<string, number> | undefined;
  };
  components?: {
    buttonPrimary?: {
      background?: string;
      textColor?: string;
      borderColor?: string;
      borderRadius?: string;
      [key: string]: string | undefined;
    };
    buttonSecondary?: {
      background?: string;
      textColor?: string;
      borderColor?: string;
      borderRadius?: string;
      [key: string]: string | undefined;
    };
    input?: {
      borderColor?: string;
      focusBorderColor?: string;
      borderRadius?: string;
      [key: string]: string | undefined;
    };
    [key: string]: unknown;
  };
  icons?: {
    style?: string;
    primaryColor?: string;
    [key: string]: string | undefined;
  };
  images?: {
    logo?: string | null;
    favicon?: string | null;
    ogImage?: string | null;
    [key: string]: string | null | undefined;
  };
  animations?: {
    transitionDuration?: string;
    easing?: string;
    [key: string]: string | undefined;
  };
  layout?: {
    grid?: {
      columns?: number;
      maxWidth?: string;
      [key: string]: number | string | undefined;
    };
    headerHeight?: string;
    footerHeight?: string;
    [key: string]:
      | number
      | string
      | Record<string, number | string | undefined>
      | undefined;
  };
  tone?: {
    voice?: string;
    emojiUsage?: string;
    [key: string]: string | undefined;
  };
  personality?: {
    tone:
      | 'professional'
      | 'playful'
      | 'modern'
      | 'traditional'
      | 'minimalist'
      | 'bold';
    energy: 'low' | 'medium' | 'high';
    targetAudience: string;
  };
  [key: string]: unknown;
}

export interface DocumentMetadata {
  // Common metadata fields
  title?: string;
  description?: string;
  url?: string;
  language?: string;
  keywords?: string | string[];
  robots?: string;

  // OpenGraph and social metadata
  ogTitle?: string;
  ogDescription?: string;
  ogUrl?: string;
  ogImage?: string;
  ogAudio?: string;
  ogDeterminer?: string;
  ogLocale?: string;
  ogLocaleAlternate?: string[];
  ogSiteName?: string;
  ogVideo?: string;

  // Dublin Core and other site metadata
  favicon?: string;
  dcTermsCreated?: string;
  dcDateCreated?: string;
  dcDate?: string;
  dcTermsType?: string;
  dcType?: string;
  dcTermsAudience?: string;
  dcTermsSubject?: string;
  dcSubject?: string;
  dcDescription?: string;
  dcTermsKeywords?: string;

  modifiedTime?: string;
  publishedTime?: string;
  articleTag?: string;
  articleSection?: string;

  // Response-level metadata
  sourceURL?: string;
  statusCode?: number;
  scrapeId?: string;
  numPages?: number;
  contentType?: string;
  proxyUsed?: 'basic' | 'stealth';
  cacheState?: 'hit' | 'miss';
  cachedAt?: string;
  creditsUsed?: number;

  // Error information
  error?: string;

  [key: string]: unknown;
}

export interface Document {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  json?: unknown;
  summary?: string;
  metadata?: DocumentMetadata;
  links?: string[];
  images?: string[];
  screenshot?: string;
  attributes?: Array<{
    selector: string;
    attribute: string;
    values: string[];
  }>;
  actions?: Record<string, unknown>;
  warning?: string;
  changeTracking?: Record<string, unknown>;
  branding?: BrandingProfile;
}

// Pagination configuration for auto-fetching pages from v2 endpoints that return a `next` URL
export interface PaginationConfig {
  /** When true (default), automatically follow `next` links and aggregate all documents. */
  autoPaginate?: boolean;
  /** Maximum number of additional pages to fetch after the first response. */
  maxPages?: number;
  /** Maximum total number of documents to return across all pages. */
  maxResults?: number;
  /** Maximum time to spend fetching additional pages (in seconds). */
  maxWaitTime?: number;
}

export interface SearchResultWeb {
  url: string;
  title?: string;
  description?: string;
  category?: string;
}

export interface SearchResultNews {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  imageUrl?: string;
  position?: number;
  category?: string;
}

export interface SearchResultImages {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  url?: string;
  position?: number;
}

export interface SearchData {
  web?: Array<SearchResultWeb | Document>;
  news?: Array<SearchResultNews | Document>;
  images?: Array<SearchResultImages | Document>;
}

export interface CategoryOption {
  type: 'github' | 'research' | 'pdf';
}

export interface SearchRequest {
  query: string;
  sources?: Array<
    'web' | 'news' | 'images' | { type: 'web' | 'news' | 'images' }
  >;
  categories?: Array<'github' | 'research' | 'pdf' | CategoryOption>;
  limit?: number;
  tbs?: string;
  location?: string;
  ignoreInvalidURLs?: boolean;
  timeout?: number; // ms
  scrapeOptions?: ScrapeOptions;
  integration?: string;
}

export interface CrawlOptions {
  prompt?: string | null;
  excludePaths?: string[] | null;
  includePaths?: string[] | null;
  maxDiscoveryDepth?: number | null;
  sitemap?: 'skip' | 'include';
  ignoreQueryParameters?: boolean;
  limit?: number | null;
  crawlEntireDomain?: boolean;
  allowExternalLinks?: boolean;
  allowSubdomains?: boolean;
  delay?: number | null;
  maxConcurrency?: number | null;
  webhook?: string | WebhookConfig | null;
  scrapeOptions?: ScrapeOptions | null;
  zeroDataRetention?: boolean;
  integration?: string;
}

export interface CrawlResponse {
  id: string;
  url: string;
}

export interface CrawlJob {
  id: string;
  status: 'scraping' | 'completed' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  creditsUsed?: number;
  expiresAt?: string;
  next?: string | null;
  data: Document[];
}

export interface BatchScrapeOptions {
  options?: ScrapeOptions;
  webhook?: string | WebhookConfig;
  appendToId?: string;
  ignoreInvalidURLs?: boolean;
  maxConcurrency?: number;
  zeroDataRetention?: boolean;
  idempotencyKey?: string;
  integration?: string;
}

export interface BatchScrapeResponse {
  id: string;
  url: string;
  invalidURLs?: string[];
}

export interface BatchScrapeJob {
  id: string;
  status: 'scraping' | 'completed' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  creditsUsed?: number;
  expiresAt?: string;
  next?: string | null;
  data: Document[];
}

export interface MapData {
  links: SearchResultWeb[];
}

export interface MapOptions {
  search?: string;
  sitemap?: 'only' | 'include' | 'skip';
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  limit?: number;
  timeout?: number;
  integration?: string;
  location?: LocationConfig;
}

export interface ExtractResponse {
  success?: boolean;
  id?: string;
  status?: 'processing' | 'completed' | 'failed' | 'cancelled';
  data?: unknown;
  error?: string;
  warning?: string;
  sources?: Record<string, unknown>;
  expiresAt?: string;
}

export interface AgentOptions {
  model: 'FIRE-1';
}

export interface ConcurrencyCheck {
  concurrency: number;
  maxConcurrency: number;
}

export interface CreditUsage {
  remainingCredits: number;
  planCredits?: number;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
}

export interface TokenUsage {
  remainingTokens: number;
  planTokens?: number;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
}

export interface CreditUsageHistoricalPeriod {
  startDate: string | null;
  endDate: string | null;
  apiKey?: string;
  creditsUsed: number;
}

export interface CreditUsageHistoricalResponse {
  success: boolean;
  periods: CreditUsageHistoricalPeriod[];
}

export interface TokenUsageHistoricalPeriod {
  startDate: string | null;
  endDate: string | null;
  apiKey?: string;
  tokensUsed: number;
}

export interface TokenUsageHistoricalResponse {
  success: boolean;
  periods: TokenUsageHistoricalPeriod[];
}

export interface CrawlErrorsResponse {
  errors: {
    id: string;
    timestamp?: string;
    url: string;
    code?: string;
    error: string;
  }[];
  robotsBlocked: string[];
}

export interface ActiveCrawl {
  id: string;
  teamId: string;
  url: string;
  options?: Record<string, unknown> | null;
}

export interface ActiveCrawlsResponse {
  success: boolean;
  crawls: ActiveCrawl[];
}

export interface ErrorDetails {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
  status?: number;
}

export class SdkError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
  constructor(
    message: string,
    status?: number,
    code?: string,
    details?: unknown
  ) {
    super(message);
    this.name = 'FirecrawlSdkError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface QueueStatusResponse {
  success: boolean;
  jobsInQueue: number;
  activeJobsInQueue: number;
  waitingJobsInQueue: number;
  maxConcurrency: number;
  mostRecentSuccess: string | null;
}
