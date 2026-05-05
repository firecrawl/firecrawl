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
  | 'branding'
  | 'audio';

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

export interface QueryFormat {
  type: 'query';
  prompt: string;
  mode?: 'freeform' | 'directQuote';
}

export type FormatOption =
  | FormatString
  | Format
  | JsonFormat
  | ChangeTrackingFormat
  | ScreenshotFormat
  | AttributesFormat
  | QueryFormat;

export type ParseFormatString = Exclude<
  FormatString,
  'screenshot' | 'changeTracking' | 'branding'
>;

export interface ParseFormat {
  type: ParseFormatString;
}

export type ParseFormatOption =
  | ParseFormatString
  | ParseFormat
  | JsonFormat
  | AttributesFormat
  | QueryFormat;

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
  parsers?: Array<string | { type: 'pdf'; mode?: 'fast' | 'auto' | 'ocr'; maxPages?: number }>;
  actions?: ActionOption[];
  location?: LocationConfig;
  skipTlsVerification?: boolean;
  removeBase64Images?: boolean;
  fastMode?: boolean;
  useMock?: string;
  blockAds?: boolean;
  proxy?: 'basic' | 'stealth' | 'enhanced' | 'auto' | string;
  maxAge?: number;
  minAge?: number;
  storeInCache?: boolean;
  lockdown?: boolean;
  profile?: {
    name: string;
    saveChanges?: boolean;
  };
  integration?: string;
  origin?: string;
}

export type ParseFileData =
  | Blob
  | File
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | string;

export interface ParseFile {
  data: ParseFileData;
  filename: string;
  contentType?: string;
}

export type ParseOptions = Omit<
  ScrapeOptions,
  | 'formats'
  | 'waitFor'
  | 'mobile'
  | 'actions'
  | 'location'
  | 'maxAge'
  | 'minAge'
  | 'storeInCache'
  | 'lockdown'
  | 'proxy'
> & {
  formats?: ParseFormatOption[];
  proxy?: 'basic' | 'auto';
};

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  events?: Array<'completed' | 'failed' | 'page' | 'started'>;
}

// Agent webhook events differ from crawl: has 'action' and 'cancelled', no 'page'
export type AgentWebhookEvent = 'started' | 'action' | 'completed' | 'failed' | 'cancelled';

export interface AgentWebhookConfig {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  events?: AgentWebhookEvent[];
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
  timezone?: string;
  proxyUsed?: 'basic' | 'stealth';
  cacheState?: 'hit' | 'miss';
  cachedAt?: string;
  creditsUsed?: number;
  concurrencyLimited?: boolean;
  concurrencyQueueDurationMs?: number;

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
  audio?: string;
  attributes?: Array<{
    selector: string;
    attribute: string;
    values: string[];
  }>;
  actions?: Record<string, unknown>;
  answer?: string;
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
  includeDomains?: string[];
  excludeDomains?: string[];
  limit?: number;
  tbs?: string;
  location?: string;
  ignoreInvalidURLs?: boolean;
  timeout?: number; // ms
  scrapeOptions?: ScrapeOptions;
  integration?: string;
  origin?: string;
}

export interface CrawlOptions {
  prompt?: string | null;
  excludePaths?: string[] | null;
  includePaths?: string[] | null;
  maxDiscoveryDepth?: number | null;
  sitemap?: 'skip' | 'include' | 'only';
  ignoreQueryParameters?: boolean;
  deduplicateSimilarURLs?: boolean;
  limit?: number | null;
  crawlEntireDomain?: boolean;
  allowExternalLinks?: boolean;
  allowSubdomains?: boolean;
  ignoreRobotsTxt?: boolean;
  robotsUserAgent?: string | null;
  delay?: number | null;
  maxConcurrency?: number | null;
  webhook?: string | WebhookConfig | null;
  scrapeOptions?: ScrapeOptions | null;
  regexOnFullURL?: boolean;
  zeroDataRetention?: boolean;
  integration?: string;
  origin?: string;
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
  origin?: string;
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
  origin?: string;
  location?: LocationConfig;
}

export interface MonitorSchedule {
  cron: string;
  timezone?: string;
}

export interface MonitorEmailNotification {
  enabled?: boolean;
  recipients?: string[];
  includeDiffs?: boolean;
}

export interface MonitorNotification {
  email?: MonitorEmailNotification;
}

export interface MonitorWebhookConfig {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  events?: string[];
}

export interface MonitorScrapeTarget {
  id?: string;
  type: 'scrape';
  urls: string[];
  scrapeOptions?: ScrapeOptions;
}

export interface MonitorCrawlTarget {
  id?: string;
  type: 'crawl';
  url: string;
  crawlOptions?: CrawlOptions;
  scrapeOptions?: ScrapeOptions;
}

export type MonitorTarget = MonitorScrapeTarget | MonitorCrawlTarget;

export interface CreateMonitorRequest {
  name: string;
  schedule: MonitorSchedule;
  webhook?: MonitorWebhookConfig;
  notification?: MonitorNotification;
  targets: MonitorTarget[];
  retentionDays?: number;
}

export interface UpdateMonitorRequest {
  name?: string;
  status?: 'active' | 'paused';
  schedule?: MonitorSchedule;
  webhook?: MonitorWebhookConfig | null;
  notification?: MonitorNotification | null;
  targets?: MonitorTarget[];
  retentionDays?: number;
}

export interface MonitorSummary {
  totalPages: number;
  same: number;
  changed: number;
  new: number;
  removed: number;
  error: number;
}

export interface Monitor {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'deleted';
  schedule: MonitorSchedule;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  currentCheckId?: string | null;
  targets: MonitorTarget[];
  webhook?: MonitorWebhookConfig | null;
  notification?: MonitorNotification | null;
  retentionDays: number;
  estimatedCreditsPerMonth?: number | null;
  lastCheckSummary?: MonitorSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorCheck {
  id: string;
  monitorId: string;
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'partial'
    | 'skipped_overlap';
  trigger: 'scheduled' | 'manual';
  scheduledFor?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  estimatedCredits?: number | null;
  reservedCredits?: number | null;
  actualCredits?: number | null;
  billingStatus:
    | 'not_applicable'
    | 'reserved'
    | 'confirmed'
    | 'released'
    | 'failed';
  summary: MonitorSummary;
  targetResults?: unknown;
  notificationStatus?: unknown;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorCheckPage {
  id: string;
  targetId: string;
  url: string;
  status: 'same' | 'new' | 'changed' | 'removed' | 'error';
  previousScrapeId?: string | null;
  currentScrapeId?: string | null;
  statusCode?: number | null;
  error?: string | null;
  metadata?: unknown;
  diff?: unknown;
  createdAt: string;
}

export interface MonitorCheckDetail extends MonitorCheck {
  pages: MonitorCheckPage[];
  next?: string | null;
}

export interface ListMonitorsOptions {
  limit?: number;
  offset?: number;
}

export type ListMonitorChecksOptions = ListMonitorsOptions;

export type GetMonitorCheckOptions = PaginationConfig & {
  limit?: number;
  skip?: number;
  status?: MonitorCheckPage["status"];
};

export interface ExtractResponse {
  success?: boolean;
  id?: string;
  status?: 'processing' | 'completed' | 'failed' | 'cancelled';
  data?: unknown;
  error?: string;
  warning?: string;
  sources?: Record<string, unknown>;
  expiresAt?: string;
  creditsUsed?: number;
}

export interface AgentResponse {
  success: boolean;
  id: string;
  error?: string;
}

export interface AgentStatusResponse {
  success: boolean;
  status: 'processing' | 'completed' | 'failed';
  error?: string;
  data?: unknown;
  model?: 'spark-1-pro' | 'spark-1-mini';
  expiresAt: string;
  creditsUsed?: number;
}

export interface AgentOptions {
  model: 'FIRE-1' | 'v3-beta';
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
  jobId?: string;
  constructor(
    message: string,
    status?: number,
    code?: string,
    details?: unknown,
    jobId?: string
  ) {
    super(message);
    this.name = 'FirecrawlSdkError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.jobId = jobId;
  }
}

export class JobTimeoutError extends SdkError {
  timeoutSeconds: number;
  constructor(jobId: string, timeoutSeconds: number, jobType: 'batch' | 'crawl' = 'batch') {
    const jobTypeLabel = jobType === 'batch' ? 'batch scrape' : 'crawl';
    super(
      `${jobTypeLabel.charAt(0).toUpperCase() + jobTypeLabel.slice(1)} job ${jobId} did not complete within ${timeoutSeconds} seconds`,
      undefined,
      'JOB_TIMEOUT',
      undefined,
      jobId
    );
    this.name = 'JobTimeoutError';
    this.timeoutSeconds = timeoutSeconds;
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

// Browser types
export interface BrowserCreateResponse {
  success: boolean;
  id?: string;
  cdpUrl?: string;
  liveViewUrl?: string;
  interactiveLiveViewUrl?: string;
  expiresAt?: string;
  error?: string;
}

export interface BrowserExecuteResponse {
  success: boolean;
  liveViewUrl?: string;
  interactiveLiveViewUrl?: string;
  output?: string;
  stdout?: string;
  result?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
  error?: string;
}

export interface BrowserDeleteResponse {
  success: boolean;
  sessionDurationMs?: number;
  creditsBilled?: number;
  error?: string;
}

export interface ScrapeExecuteRequest {
  code?: string;
  prompt?: string;
  language?: "python" | "node" | "bash";
  timeout?: number;
  origin?: string;
}

export type ScrapeExecuteResponse = BrowserExecuteResponse;
export type ScrapeBrowserDeleteResponse = BrowserDeleteResponse;

export interface BrowserSession {
  id: string;
  status: string;
  cdpUrl: string;
  liveViewUrl: string;
  interactiveLiveViewUrl?: string;
  streamWebView: boolean;
  createdAt: string;
  lastActivity: string;
}

export interface BrowserListResponse {
  success: boolean;
  sessions?: BrowserSession[];
  error?: string;
}
