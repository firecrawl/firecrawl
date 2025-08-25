import type { ZodTypeAny } from "zod";
// Public types for Firecrawl JS/TS SDK v2 (camelCase only)

export type FormatString =
  | "markdown"
  | "html"
  | "rawHtml"
  | "links"
  | "screenshot"
  | "summary"
  | "changeTracking"
  | "json"
  | "attributes";

export interface Viewport {
  width: number;
  height: number;
}

export interface Format {
  type: FormatString;
}

export interface JsonFormat extends Format {
  type: "json";
  prompt?: string;
  schema?: Record<string, unknown> | ZodTypeAny;
}

export interface ScreenshotFormat {
  type: "screenshot";
  fullPage?: boolean;
  quality?: number;
  viewport?: Viewport | { width: number; height: number };
}

export interface ChangeTrackingFormat extends Format {
  type: "changeTracking";
  modes: ("git-diff" | "json")[];
  schema?: Record<string, unknown>;
  prompt?: string;
  tag?: string;
}
export interface AttributesFormat extends Format {
  type: "attributes";
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
  type: "wait";
  milliseconds?: number;
  selector?: string;
}

export interface ScreenshotAction {
  type: "screenshot";
  fullPage?: boolean;
  quality?: number;
  viewport?: Viewport | { width: number; height: number };
}

export interface ClickAction {
  type: "click";
  selector: string;
}

export interface WriteAction {
  type: "write";
  text: string;
}

export interface PressAction {
  type: "press";
  key: string;
}

export interface ScrollAction {
  type: "scroll";
  direction: "up" | "down";
  selector?: string;
}

export interface ScrapeAction {
  type: "scrape";
}

export interface ExecuteJavascriptAction {
  type: "executeJavascript";
  script: string;
}

export interface PDFAction {
  type: "pdf";
  format?: "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "Letter" | "Legal" | "Tabloid" | "Ledger";
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
  parsers?: string[];
  actions?: ActionOption[];
  location?: LocationConfig;
  skipTlsVerification?: boolean;
  removeBase64Images?: boolean;
  fastMode?: boolean;
  useMock?: string;
  blockAds?: boolean;
  proxy?: "basic" | "stealth" | "auto" | string;
  maxAge?: number;
  storeInCache?: boolean;
}

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  events?: Array<"completed" | "failed" | "page" | "started">;
}

export interface DocumentMetadata {
  title?: string;
  description?: string;
  language?: string;
  keywords?: string | string[];
  robots?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogUrl?: string;
  ogImage?: string;
  sourceURL?: string;
  statusCode?: number;
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
  screenshot?: string;
  attributes?: Array<{
    selector: string;
    attribute: string;
    values: string[];
  }>;
  actions?: Record<string, unknown>;
  warning?: string;
  changeTracking?: Record<string, unknown>;
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
  type: "github" | "research";
}

export interface SearchRequest {
  query: string;
  sources?: Array<"web" | "news" | "images" | { type: "web" | "news" | "images" }>;
  categories?: Array<"github" | "research" | CategoryOption>;
  limit?: number;
  tbs?: string;
  location?: string;
  ignoreInvalidURLs?: boolean;
  timeout?: number; // ms
  scrapeOptions?: ScrapeOptions;
}

export interface CrawlOptions {
  prompt?: string | null;
  excludePaths?: string[] | null;
  includePaths?: string[] | null;
  maxDiscoveryDepth?: number | null;
  sitemap?: "skip" | "include";
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
}

export interface CrawlResponse {
  id: string;
  url: string;
}

export interface CrawlJob {
  status: "scraping" | "completed" | "failed" | "cancelled";
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
  integration?: string;
  idempotencyKey?: string;
}

export interface BatchScrapeResponse {
  id: string;
  url: string;
  invalidURLs?: string[];
}

export interface BatchScrapeJob {
  status: "scraping" | "completed" | "failed" | "cancelled";
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
  sitemap?: "only" | "include" | "skip";
  includeSubdomains?: boolean;
  limit?: number;
  timeout?: number;
}

export interface ExtractResponse {
  success?: boolean;
  id?: string;
  status?: "processing" | "completed" | "failed" | "cancelled";
  data?: unknown;
  error?: string;
  warning?: string;
  sources?: Record<string, unknown>;
  expiresAt?: string;
}

export interface ConcurrencyCheck {
  concurrency: number;
  maxConcurrency: number;
}

export interface CreditUsage {
  remainingCredits: number;
}

export interface TokenUsage {
  remainingTokens: number;
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
  constructor(message: string, status?: number, code?: string, details?: unknown) {
    super(message);
    this.name = "FirecrawlSdkError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

