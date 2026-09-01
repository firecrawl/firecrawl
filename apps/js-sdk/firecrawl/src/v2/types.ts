import type { ZodTypeAny } from "zod";
// Public types for Firecrawl JS/TS SDK v2 (camelCase only)

export type FormatString =
  | "markdown"
  | "html"
  | "rawHtml"
  | "links"
  | "images"
  | "screenshot"
  | "summary"
  | "changeTracking"
  | "json"
  | "attributes"
  | "branding"
  | "product"
  | "menu"
  | "audio"
  | "video";

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
  checkPromptInjection?: boolean;
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
  /**
   * Either a JSON Schema object or a Zod schema. Zod schemas are
   * auto-converted to JSON Schema by the SDK before being sent — see
   * `utils/validation.ts`.
   */
  schema?: Record<string, unknown> | ZodTypeAny;
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

export interface QuestionFormat {
  type: "question";
  question: string;
}

export interface HighlightsFormat {
  type: "highlights";
  query: string;
}

/** @deprecated Use QuestionFormat or HighlightsFormat instead. */
export interface QueryFormat {
  type: "query";
  prompt: string;
  mode?: "freeform" | "directQuote";
}

export type FormatOption =
  | FormatString
  | Format
  | JsonFormat
  | ChangeTrackingFormat
  | ScreenshotFormat
  | AttributesFormat
  | QuestionFormat
  | HighlightsFormat
  | QueryFormat;

export type ParseFormatString = Exclude<
  FormatString,
  "screenshot" | "changeTracking" | "branding" | "audio" | "video"
>;

export interface ParseFormat {
  type: ParseFormatString;
}

export type ParseFormatOption =
  | ParseFormatString
  | ParseFormat
  | JsonFormat
  | AttributesFormat
  | QuestionFormat
  | HighlightsFormat
  | QueryFormat;

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
  format?:
    | "A0"
    | "A1"
    | "A2"
    | "A3"
    | "A4"
    | "A5"
    | "A6"
    | "Letter"
    | "Legal"
    | "Tabloid"
    | "Ledger";
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

export interface AuditMetadata {
  username: string;
}

export type PDFParser = {
  type: "pdf";
  mode?: "fast" | "auto" | "ocr";
  maxPages?: number;
  /** Include physical per-page markdown alongside document markdown. Populates `document.pages`. */
  pages?: boolean;
  /**
   * @deprecated Renamed to `pages`. The API still accepts this as a silent alias.
   */
  pageMarkdown?: boolean;
  /** Include per-page typed layout blocks (bounding boxes, block types, reading order). */
  blocks?: boolean;
  /**
   * Join PDF pages in `document.markdown` with `\n\n---\n\n<!-- page N -->\n\n`,
   * where N is the 1-based physical page of the content that follows. Markers
   * appear between pages only (no leading marker for page 1), and numbering may
   * skip pages merged by cross-page stitching — use `pages: true` when every
   * physical page is needed. No new response field.
   */
  pageMarkers?: boolean;
};

export interface PdfPage {
  pageNumber: number;
  markdown: string;
}

export interface PdfBlockConfidence {
  layout: number | null;
  ocr: number | null;
}

export interface PdfBlockItem {
  id: string;
  type: string;
  label: string | null;
  bbox: [number, number, number, number] | null;
  content: string;
  markdownSpan: [number, number] | null;
  readingOrder: number;
  source: string | null;
  confidence: PdfBlockConfidence;
}

export interface PdfPageBlocks {
  pageNumber: number;
  width: number | null;
  height: number | null;
  status: string;
  items: PdfBlockItem[];
}

export interface ScrapeOptions {
  formats?: FormatOption[];
  headers?: Record<string, string>;
  includeTags?: string[];
  excludeTags?: string[];
  onlyMainContent?: boolean;
  timeout?: number;
  waitFor?: number;
  mobile?: boolean;
  parsers?: Array<string | PDFParser>;
  actions?: ActionOption[];
  location?: LocationConfig;
  skipTlsVerification?: boolean;
  removeBase64Images?: boolean;
  fastMode?: boolean;
  useMock?: string;
  blockAds?: boolean;
  proxy?: "basic" | "stealth" | "enhanced" | "auto" | string;
  /**
   * Maximum age, in milliseconds, of indexed content that may be reused.
   * Set to `0` to bypass index reuse.
   */
  maxAge?: number;
  minAge?: number;
  storeInCache?: boolean;
  lockdown?: boolean;
  redactPII?: boolean | RedactPIIOptions;
  threatProtection?: ThreatProtectionOptions;
  auditMetadata?: AuditMetadata;
  profile?: {
    name: string;
    saveChanges?: boolean;
  };
  integration?: string;
  origin?: string;
}

export type RedactPIIEntity =
  "PERSON" | "EMAIL" | "PHONE" | "LOCATION" | "FINANCIAL" | "SECRET";

export interface RedactPIIOptions {
  /**
   * accurate (default): model-only redaction. Best precision, cleanest output.
   * aggressive: model + Presidio + spaCy. Higher recall at the cost of precision.
   * fast: Presidio only, no model call. Lower F1, ~2x throughput.
   */
  mode?: "accurate" | "aggressive" | "fast";
  /** Restrict redaction to these entity buckets. Unset means all entities. */
  entities?: RedactPIIEntity[];
  /**
   * tag (default): replace spans with `<KIND>` placeholders.
   * mask: replace spans with `*` of equal length.
   * remove: drop span characters entirely.
   */
  replaceStyle?: "tag" | "mask" | "remove";
}

/**
 * Enterprise: per-request field-level override of your team's threat
 * protection policy. Requires threat protection to be enabled for your team
 * and request overrides to be allowed in the team configuration. Only the
 * fields you provide replace the team policy's values.
 */
export interface ThreatProtectionOptions {
  /** "off" disables scanning for this request; "normal" applies the policy. */
  mode?: "off" | "normal";
  /** Block verdicts at or above this risk score (integer 0-100). */
  riskScoreThreshold?: number;
  /** Exact domains or globs like "*.example.com" to always block (max 1000). */
  blacklist?: string[];
  /** Exact domains or globs to always allow; wins over everything (max 1000). */
  whitelist?: string[];
  /** Lowercase TLDs without the leading dot, e.g. "zip" (max 1000). */
  blockedTlds?: string[];
  /** Behavior when scanning is unavailable: "closed" blocks, "open" allows. */
  failurePolicy?: "open" | "closed";
}

export type ParseFileData =
  Blob | File | Buffer | Uint8Array | ArrayBuffer | string;

export interface ParseFile {
  data: ParseFileData;
  filename: string;
  contentType?: string;
}

export type ParseOptions = Omit<
  ScrapeOptions,
  | "formats"
  | "waitFor"
  | "mobile"
  | "actions"
  | "location"
  | "maxAge"
  | "minAge"
  | "storeInCache"
  | "lockdown"
  | "proxy"
  | "threatProtection"
> & {
  formats?: ParseFormatOption[];
  proxy?: "basic" | "auto";
};

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  events?: Array<"completed" | "failed" | "page" | "started">;
}

// Agent webhook events differ from crawl: has 'action' and 'cancelled', no 'page'
export type AgentWebhookEvent =
  "started" | "action" | "completed" | "failed" | "cancelled";

export interface AgentWebhookConfig {
  url: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  events?: AgentWebhookEvent[];
}

export interface BrandingProfile {
  colorScheme?: "light" | "dark";
  brandName?: string;
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
      number | string | Record<string, number | string | undefined> | undefined;
  };
  tone?: {
    voice?: string;
    emojiUsage?: string;
    [key: string]: string | undefined;
  };
  personality?: {
    tone:
      | "professional"
      | "playful"
      | "modern"
      | "traditional"
      | "minimalist"
      | "bold";
    energy: "low" | "medium" | "high";
    targetAudience: string;
  };
  [key: string]: unknown;
}

export interface ProductPrice {
  amount: number;
  currency?: string;
  formatted?: string;
}

export interface ProductAvailability {
  inStock: boolean;
  text?: string;
}

export interface ProductImage {
  url: string;
  alt?: string;
}

export interface ProductSale {
  originalPrice: ProductPrice;
}

export interface ProductVariant {
  id?: string;
  sku?: string;
  title?: string;
  values?: Record<string, unknown>;
  price?: ProductPrice;
  sale?: ProductSale;
  availability: ProductAvailability;
  images?: ProductImage[];
}

export interface ProductProfile {
  title: string;
  brand?: string;
  category?: string;
  url: string;
  description?: string;
  variants: ProductVariant[];
}

export interface MenuPrice {
  amount: number;
  currency?: string;
  formatted?: string;
}

export interface MenuAvailability {
  inStock: boolean;
  text?: string;
}

export interface MenuImage {
  url: string;
  alt?: string;
}

export interface MenuItemIdentifiers {
  merchantItemId?: string;
}

export interface MenuItem {
  id: string;
  name: string;
  description?: string;
  images: MenuImage[];
  price?: MenuPrice;
  availability: MenuAvailability;
  dietary: string[];
  calories?: number;
  optionGroups: unknown[];
  identifiers: MenuItemIdentifiers;
  url?: string;
  sourceUrl: string;
}

export interface MenuSection {
  id: string;
  name: string;
  description?: string;
  items: MenuItem[];
}

export interface MenuMerchant {
  name: string;
  type?: string | null;
  location?: unknown;
}

export interface MenuProfile {
  isMenu: boolean;
  confidence: number;
  merchant: MenuMerchant;
  currency?: string | null;
  sections: MenuSection[];
  sourceUrl: string;
}

export interface DocumentMetadata {
  // Common metadata fields
  title?: string;
  description?: string;
  /** URL reported by the selected scrape engine. */
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
  /** URL requested for the scrape. */
  sourceURL?: string;
  /** HTTP status code reported for the scrape response. */
  statusCode?: number;
  scrapeId?: string;
  numPages?: number;
  totalPages?: number;
  contentType?: string;
  timezone?: string;
  proxyUsed?: "basic" | "stealth";
  cacheState?: "hit" | "miss";
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
  video?: string;
  attributes?: Array<{
    selector: string;
    attribute: string;
    values: string[];
  }>;
  actions?: Record<string, unknown>;
  answer?: string;
  highlights?: string;
  warning?: string;
  changeTracking?: Record<string, unknown>;
  branding?: BrandingProfile;
  product?: ProductProfile;
  menu?: MenuProfile;
  /** Physical PDF pages, present only when `parsers[].pages` is true. */
  pages?: PdfPage[];
  /** Typed PDF layout blocks, present only when `parsers[].blocks` is true. */
  blocks?: PdfPageBlocks[];
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

export type DeveloperSearchType = "doc" | "issue" | "pull_request" | "readme";

export interface DeveloperSearchOptions {
  /** Total ranked results, 1–100 (default 10). */
  k?: number;
  /** Passages per result, 1–5 (default 1). */
  passages?: number;
  /** Result kinds to search (default all). */
  types?: DeveloperSearchType[];
  /** GitHub owner/name filters, at most 20. */
  repos?: string[];
  /** Developer documentation source IDs, at most 20. */
  sources?: string[];
  /** One case-insensitive GitHub Linguist primary language. */
  language?: string;
  /** Repository topics that must all match, at most 8. */
  topic?: string[];
  /** One case-insensitive SPDX repository license identifier. */
  license?: string;
  /** Minimum repository stars. */
  minStars?: number;
  /** Maximum repository stars. */
  maxStars?: number;
  /** Filter by repository archived status. */
  archived?: boolean;
  /** Filter by repository fork status. */
  fork?: boolean;
  /** Return packaged agent-skill evidence only. */
  skills?: "only";
}

export interface DeveloperSearchLicenseDisclosure {
  state: "licensed" | "known_absent" | "unknown";
  spdx_id: string | null;
}

export interface DeveloperSearchPassage {
  text: string;
  citation_url?: string;
}

export interface DeveloperSearchResult {
  id: string;
  url: string;
  title?: string;
  passages: DeveloperSearchPassage[];
  // Accept both shapes while the API flattens license objects to SPDX strings.
  license?: DeveloperSearchLicenseDisclosure | string;
}

export interface DeveloperSearchRepoStatus {
  repo: string;
  indexed: boolean;
  types: { issue: boolean; pullRequest: boolean; readme: boolean };
}

export interface DeveloperSearchSourceStatus {
  source: string;
  indexed: boolean;
}

export interface DeveloperSearchResponse {
  success: boolean;
  results: DeveloperSearchResult[];
  /** Present only when repos were requested. */
  repos?: DeveloperSearchRepoStatus[];
  /** Present only when sources were requested. */
  sources?: DeveloperSearchSourceStatus[];
}

export interface SearchResultWeb {
  url: string;
  title?: string;
  description?: string;
  position?: number;
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

/**
 * Narrows ordinary **web search**. A category does not switch `search()` to a
 * different index.
 *
 * - `github` — restrict web results to github.com (a `site:` filter).
 * - `research` — restrict web results to a fixed list of ~14 academic
 *   *websites* (arxiv.org, pubmed.ncbi.nlm.nih.gov, nature.com, science.org,
 *   ieee.org, sciencedirect.com, biorxiv.org, medrxiv.org, ...). It returns
 *   ordinary web page results from those domains, **not** paper records.
 * - `pdf` — restrict results to PDFs (adds `filetype:pdf`).
 * - `developer` — developer-index results (issues, pull requests, READMEs and
 *   documentation) served in `web`; cannot be combined with other categories.
 *
 * ⚠️ `categories: ["research"]` is **not** Firecrawl's research paper index.
 * To search papers themselves — ~43M abstracts, roughly 90% biomedical
 * (PubMed, bioRxiv, medRxiv) plus arXiv — with full abstracts, in-body passage
 * reads and citation-graph expansion, use `firecrawl.research.searchPapers()`
 * (plus `getPaper()` and `similarPapers()`), which call `/v2/search/research`.
 *
 * Rule of thumb: literature search → `research.searchPapers()`; web pages that
 * happen to live on academic domains → `search({ categories: ["research"] })`.
 */
export interface CategoryOption {
  type: "github" | "research" | "pdf" | "developer";
}

export interface SearchRequest {
  query: string;
  sources?: Array<
    "web" | "news" | "images" | { type: "web" | "news" | "images" }
  >;
  /**
   * Narrow web search by category. See {@link CategoryOption}.
   *
   * ⚠️ `"research"` is a website/domain filter over ordinary web search (~14
   * academic domains), **not** the research paper index. For literature search
   * over ~43M paper abstracts (PubMed / bioRxiv / medRxiv / arXiv) use
   * `firecrawl.research.searchPapers()` instead.
   */
  categories?: Array<
    "github" | "research" | "pdf" | "developer" | CategoryOption
  >;
  includeDomains?: string[];
  excludeDomains?: string[];
  limit?: number;
  tbs?: string;
  location?: string;
  ignoreInvalidURLs?: boolean;
  timeout?: number; // ms
  /** Generate query-relevant highlights for search results. Defaults to true. */
  highlights?: boolean;
  scrapeOptions?: ScrapeOptions;
  /**
   * Enterprise search options. Use `["zdr"]` for end-to-end Zero Data
   * Retention or `["anon"]` for anonymized search. Must be enabled for
   * your team.
   */
  enterprise?: Array<"default" | "anon" | "zdr">;
  threatProtection?: ThreatProtectionOptions;
  integration?: string;
  origin?: string;
}

export interface CrawlOptions {
  prompt?: string | null;
  excludePaths?: string[] | null;
  includePaths?: string[] | null;
  maxDiscoveryDepth?: number | null;
  sitemap?: "skip" | "include" | "only";
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
  status: "scraping" | "completed" | "failed" | "cancelled";
  completed: number;
  total: number;
  creditsUsed?: number;
  expiresAt?: string;
  next?: string | null;
  data: Document[];
}

export interface MapData {
  id?: string;
  links: SearchResultWeb[];
}

export interface MapOptions {
  search?: string;
  sitemap?: "only" | "include" | "skip";
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  limit?: number;
  timeout?: number;
  integration?: string;
  origin?: string;
  location?: LocationConfig;
  threatProtection?: ThreatProtectionOptions;
  auditMetadata?: AuditMetadata;
}

export type FeedbackRating = "good" | "partial" | "bad";
export type EndpointFeedbackEndpoint = "search" | "scrape" | "parse" | "map";

export interface FeedbackValuableSource {
  url: string;
  reason?: string;
}

export interface FeedbackMissingContent {
  topic: string;
  description?: string;
}

export interface SearchFeedbackRequest {
  rating: FeedbackRating;
  valuableSources?: FeedbackValuableSource[];
  missingContent?: FeedbackMissingContent[];
  querySuggestions?: string;
  integration?: string | null;
  origin?: string;
}

export interface EndpointFeedbackRequest extends SearchFeedbackRequest {
  endpoint: EndpointFeedbackEndpoint;
  jobId: string;
  issues?: string[];
  tags?: string[];
  note?: string;
  url?: string;
  pageNumbers?: number[];
  /** Small endpoint-specific metadata object. Must be 8KB or smaller. */
  metadata?: Record<string, unknown>;
}

export interface FeedbackResponse {
  success: true;
  feedbackId: string;
  creditsRefunded: number;
  alreadySubmitted?: boolean;
  dailyCapReached?: boolean;
  creditsRefundedToday?: number;
  dailyRefundCap?: number;
  warning?: string;
}

/**
 * Schedule for a monitor.
 *
 * On create/update, provide exactly one of `cron` or `text`:
 *  - `cron`: a 5-field cron expression (e.g. `"*\u002F30 * * * *"`).
 *  - `text`: a natural-language schedule (e.g. `"every 30 minutes"`,
 *    `"hourly"`, `"daily at 9:00"`). Firecrawl normalizes this to a cron
 *    expression server-side.
 *
 * On read, the API always returns the normalized `cron` value, so `cron`
 * is populated in responses even when the monitor was created with `text`.
 */
export interface MonitorSchedule {
  cron?: string;
  text?: string;
  timezone?: string;
}

export interface MonitorEmailNotification {
  enabled?: boolean;
  recipients?: string[];
  includeDiffs?: boolean;
}

/**
 * Per-recipient opt-in state for monitor email notifications.
 *
 * External recipients (not members of the team that owns the monitor) must
 * confirm their subscription via a one-time email before they receive any
 * monitor notifications. Team members are auto-confirmed.
 *
 * - `pending`      → confirmation email sent, no notifications yet
 * - `confirmed`    → notifications enabled
 * - `unsubscribed` → recipient opted out and cannot be re-added without a new
 *                    confirmation flow
 */
export interface MonitorEmailRecipientSubscription {
  email: string;
  status: "pending" | "confirmed" | "unsubscribed";
  source: "team" | "opt_in" | "legacy";
  confirmationEmailSent?: boolean;
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
  type: "scrape";
  urls: string[];
  scrapeOptions?: ScrapeOptions;
}

export interface MonitorCrawlTarget {
  id?: string;
  type: "crawl";
  url: string;
  crawlOptions?: CrawlOptions;
  scrapeOptions?: ScrapeOptions;
}

export interface MonitorSearchTarget {
  id?: string;
  type: "search";
  queries: string[];
  searchWindow?: "5m" | "15m" | "1h" | "6h" | "24h" | "7d";
  includeDomains?: string[];
  excludeDomains?: string[];
  maxResults?: number;
}

export type MonitorTarget =
  MonitorScrapeTarget | MonitorCrawlTarget | MonitorSearchTarget;

export interface CreateMonitorRequest {
  name: string;
  schedule: MonitorSchedule;
  webhook?: MonitorWebhookConfig;
  notification?: MonitorNotification;
  targets: MonitorTarget[];
  retentionDays?: number;
  goal?: string;
  judgeEnabled?: boolean;
}

export interface UpdateMonitorRequest {
  name?: string;
  status?: "active" | "paused";
  schedule?: MonitorSchedule;
  webhook?: MonitorWebhookConfig | null;
  notification?: MonitorNotification | null;
  targets?: MonitorTarget[];
  retentionDays?: number;
  goal?: string | null;
  judgeEnabled?: boolean;
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
  status: "active" | "paused" | "deleted";
  schedule: MonitorSchedule;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  currentCheckId?: string | null;
  targets: MonitorTarget[];
  webhook?: MonitorWebhookConfig | null;
  notification?: MonitorNotification | null;
  /**
   * Present on create/update/get responses. Reflects the opt-in state of every
   * email recipient currently configured on the monitor. Absent when the API
   * has not reconciled recipients (e.g. team-default delivery with no
   * explicit recipients).
   */
  emailRecipientSubscriptions?: MonitorEmailRecipientSubscription[];
  retentionDays: number;
  estimatedCreditsPerMonth?: number | null;
  lastCheckSummary?: MonitorSummary | null;
  goal?: string | null;
  judgeEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorPageJudgment {
  meaningful: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  meaningfulChanges: Array<{
    type: "added" | "removed" | "changed";
    before: string | null;
    after: string | null;
    reason: string;
  }>;
}

export interface MonitorScrapeTargetResult {
  targetId: string;
  type: "scrape";
  expectedJobs?: string[];
}

export interface MonitorCrawlTargetResult {
  targetId: string;
  type: "crawl";
  crawlId?: string;
}

export interface MonitorSearchTargetResult {
  targetId: string;
  type: "search";
  searchCompleted?: boolean;
  resultCount?: number;
  matches?: number;
  summary?: string;
  judgeDegraded?: boolean;
  degradedReason?: string | null;
  searchCredits?: number;
  judgeCredits?: number;
  resultsJudged?: number;
}

export type MonitorTargetResult =
  | MonitorScrapeTargetResult
  | MonitorCrawlTargetResult
  | MonitorSearchTargetResult;

export interface MonitorCheck {
  id: string;
  monitorId: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "partial"
    | "skipped_overlap"
    | "skipped_no_credits";
  trigger: "scheduled" | "manual";
  scheduledFor?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  estimatedCredits?: number | null;
  reservedCredits?: number | null;
  actualCredits?: number | null;
  billingStatus:
    "not_applicable" | "reserved" | "confirmed" | "released" | "failed";
  summary: MonitorSummary;
  targetResults?: MonitorTargetResult[];
  notificationStatus?: unknown;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-field diff for monitors that requested JSON extraction. */
export interface MonitorJsonFieldDiff {
  [field: string]: { previous: unknown; current: unknown };
}

/**
 * Diff payload returned alongside a monitor page when its scrape produced
 * a change. The shape depends on what the monitor's formats asked for:
 *
 *  - markdown-only monitors  → `{ text, json }` where `json` is the
 *    `parseDiff` AST (a `{ files: [...] }` object).
 *  - JSON-extraction monitors → `{ json }` where `json` is the per-field
 *    `{ previous, current }` map.
 *  - Mixed (JSON + git-diff) monitors → both `text` (markdown sidecar)
 *    and `json` (field-level diff) are present.
 */
export interface MonitorPageDiff {
  text?: string;
  /** Markdown variants: parseDiff AST. JSON variants: per-field diff. */
  json?: MonitorJsonFieldDiff | { files: unknown[] };
}

/**
 * Snapshot of the current JSON extraction at this run. Present on JSON
 * and mixed-mode monitors; absent for markdown-only.
 */
export interface MonitorPageSnapshot {
  json?: Record<string, unknown>;
}

export interface MonitorCheckPage {
  id: string;
  targetId: string;
  url: string;
  status: "same" | "new" | "changed" | "removed" | "error";
  previousScrapeId?: string | null;
  currentScrapeId?: string | null;
  statusCode?: number | null;
  error?: string | null;
  metadata?: unknown;
  diff?: MonitorPageDiff | null;
  snapshot?: MonitorPageSnapshot | null;
  judgment?: MonitorPageJudgment | null;
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
  status?: "processing" | "completed" | "failed" | "cancelled";
  data?: unknown;
  error?: string;
  warning?: string;
  warnings?: string[];
  replacement?: string;
  sources?: Record<string, unknown>;
  expiresAt?: string;
  creditsUsed?: number;
}

/** Conversation mode for an agent run. Defaults to "extract" server-side. */
export type AgentMode = "extract" | "chat";

/** Options forwarded verbatim to the agent; the server owns every default. */
export interface AgentExchangeOptions {
  enabled?: boolean;
  /** At most 5. */
  toolkits?: string[];
  maxCalls?: number;
  requireApproval?: boolean;
  /** Answers a pendingApproval from the previous turn of the thread. */
  approve?: { approvalId: string; callIds?: string[]; always?: boolean };
  decline?: { approvalId: string };
}

/** Per-run summary reported on a status response. */
export interface AgentExchangeSummary {
  enabled: boolean;
  /** What the run resolved to after thread inheritance, not what it requested. */
  toolkits?: string[];
  requireApproval?: boolean;
  paidCalls: number;
  creditsUsed: number | null;
}

/** A follow-up the agent offers for the next turn of the thread. */
export interface AgentSuggestion {
  label: string;
  prompt: string;
}

/** A turn that ended waiting for the caller to allow or refuse paid calls. */
export interface PendingApproval {
  id: string;
  reason: string;
  calls: {
    id: string;
    provider: string;
    capability: string;
    input: Record<string, unknown>;
    more?: Record<string, unknown>[];
    creditsEstimate: number | null;
  }[];
  resolution: null | {
    approved: boolean;
    callIds: string[];
    always: boolean;
    byRunId: string;
  };
}

export interface AgentResponse {
  success: boolean;
  id: string;
  error?: string;
  /** Thread this run belongs to; pass it back to continue the conversation. */
  threadId?: string;
  /** 1-based position of this run in its thread. */
  threadTurn?: number;
}

export interface AgentStatusResponse {
  success: boolean;
  status: "processing" | "completed" | "failed";
  error?: string;
  data?: unknown;
  /**
   * Server-provided model name. Widened past the request-side union on
   * purpose: new models ship without an SDK release, so pinning this to known
   * names makes every future model a type error at the call site.
   */
  model?: "spark-1-pro" | "spark-1-mini" | "spark-2" | (string & {});
  /**
   * Reasoning effort the job ran with. Only set for runs that specified it;
   * older rows and default runs have no effort.
   */
  effort?: "low" | "medium" | "high";
  expiresAt: string;
  creditsUsed?: number;
  threadId?: string;
  threadTurn?: number;
  mode?: AgentMode;
  /** Assistant text reply. Chat-mode runs answer here instead of in `data`. */
  message?: string;
  suggestions?: AgentSuggestion[];
  pendingApproval?: PendingApproval;
  exchange?: AgentExchangeSummary;
}

/** A single run of a thread, as returned by getAgentThread. */
export interface AgentThreadRun {
  id: string;
  turn: number;
  mode: AgentMode;
  prompt: string;
  urls?: string[];
  schema?: unknown;
  effort?: "low" | "medium" | "high";
  status:
    | "processing"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "refused"
    | "credit_limit_reached";
  createdAt: string;
  finishedAt: string | null;
  creditsUsed: number | null;
  message: string | null;
  /** Only present when the request asked for includeData. */
  data?: unknown;
  suggestions?: AgentSuggestion[] | null;
  pendingApproval?: PendingApproval | null;
  exchange?: AgentExchangeSummary | null;
}

export interface AgentThread {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running";
  runs: AgentThreadRun[];
}

export interface AgentThreadResponse {
  success: boolean;
  thread?: AgentThread;
  error?: string;
}

/** Reasoning effort for agent jobs. Every level runs spark-2. */
export type AgentEffort = "low" | "medium" | "high";

/** A single agent run as returned by the agent list endpoint. */
export interface AgentListItem {
  id: string;
  createdAt: string;
  targetHint: string;
  origin: string;
  integration?: string;
  settings: {
    hidden: boolean;
    starred: boolean;
    label?: string;
  };
  status: "processing" | "completed" | "failed";
  options?: {
    urls?: string[];
    prompt: string;
    schema?: unknown;
    /**
     * Server-provided model name. Widened past the request-side union on
     * purpose: new models ship without an SDK release, so pinning this to
     * known names makes every future model a type error at the call site.
     */
    model: "spark-1-pro" | "spark-1-mini" | "spark-2" | (string & {});
    effort?: AgentEffort;
  };
}

export interface AgentListResponse {
  success: boolean;
  agents?: AgentListItem[];
  /**
   * Absolute URL of the next page (pass its `before` value to listAgents to
   * continue). Only present when more pages exist.
   */
  next?: string;
  error?: string;
}

/** Options for listing agent runs. */
export interface AgentListOptions {
  /** Only return agent runs created before this unix millisecond timestamp. */
  before?: number;
}

export type AgentTraceAgentRole =
  "orchestrator" | "subagent" | "browser" | "system";

export interface AgentTraceAgentIdentity {
  id: string;
  role: AgentTraceAgentRole;
  name: string;
  parentId?: string;
}

export interface AgentTraceError {
  code:
    | "cancelled"
    | "credit_limit_reached"
    | "parent_finished"
    | "refused"
    | "internal";
  source: "agent" | "tool" | "billing" | "system";
  retryable: boolean;
  message: string;
}

export interface AgentTraceArtifactChange {
  kind: "json" | "markdown" | "html" | "screenshot" | "text";
  artifactId: string;
  path?: string;
  /** Fetch the full content via getAgentSnapshot(jobId, snapshotId). */
  snapshotId: string;
  change: "init" | "partial" | "append" | "modify" | "update";
  changedFields?: string[];
  itemCount?: number;
  sourceToolCallId?: string;
}

interface AgentTraceEventBase {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  occurredAt: string;
  producerSequence: number;
  agent: AgentTraceAgentIdentity;
}

export interface AgentTraceRunStartedEvent extends AgentTraceEventBase {
  type: "run.started";
}

export interface AgentTraceRunCancelRequestedEvent extends AgentTraceEventBase {
  type: "run.cancel_requested";
  reason: "user";
}

export interface AgentTraceRunFinishedEvent extends AgentTraceEventBase {
  type: "run.finished";
  outcome:
    "succeeded" | "failed" | "cancelled" | "refused" | "credit_limit_reached";
  /** The canonical schema always writes this key (nullable), but older rows may omit it. */
  error?: AgentTraceError | null;
}

export interface AgentTraceAgentStartedEvent extends AgentTraceEventBase {
  type: "agent.started";
}

export interface AgentTraceAgentFinishedEvent extends AgentTraceEventBase {
  type: "agent.finished";
  outcome: "succeeded" | "failed" | "cancelled" | "refused";
  durationMs: number;
  /** The canonical schema always writes this key (nullable), but older rows may omit it. */
  error?: AgentTraceError | null;
}

export interface AgentTraceBrowserSessionStartedEvent extends AgentTraceEventBase {
  type: "browser.session.started";
  sessionId: string;
}

export interface AgentTraceBrowserSessionFinishedEvent extends AgentTraceEventBase {
  type: "browser.session.finished";
  sessionId: string;
  durationMs: number;
}

export interface AgentTraceProgressReportedEvent extends AgentTraceEventBase {
  type: "progress.reported";
  phase: "planning" | "working" | "finalizing";
  message: string;
}

export interface AgentTraceReasoningSummaryEvent extends AgentTraceEventBase {
  type: "reasoning.summary";
  text: string;
}

export interface AgentTraceToolCallStartedEvent extends AgentTraceEventBase {
  type: "tool_call.started";
  toolCallId: string;
  toolName: string;
  parameters: unknown;
}

export interface AgentTraceToolCallFinishedEvent extends AgentTraceEventBase {
  type: "tool_call.finished";
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export interface AgentTraceArtifactUpdatedEvent extends AgentTraceEventBase {
  type: "artifact.updated";
  artifact: AgentTraceArtifactChange;
}

export interface AgentTraceErrorOccurredEvent extends AgentTraceEventBase {
  type: "error.occurred";
  error: AgentTraceError;
}

/**
 * One event in an agent job's trace. Mirrors the canonical event schema of
 * the agent service (schemaVersion 1); `usage.recorded` events are withheld
 * server-side and `agent.started` carries no model name.
 */
export type AgentTraceEvent =
  | AgentTraceRunStartedEvent
  | AgentTraceRunCancelRequestedEvent
  | AgentTraceRunFinishedEvent
  | AgentTraceAgentStartedEvent
  | AgentTraceAgentFinishedEvent
  | AgentTraceBrowserSessionStartedEvent
  | AgentTraceBrowserSessionFinishedEvent
  | AgentTraceProgressReportedEvent
  | AgentTraceReasoningSummaryEvent
  | AgentTraceToolCallStartedEvent
  | AgentTraceToolCallFinishedEvent
  | AgentTraceArtifactUpdatedEvent
  | AgentTraceErrorOccurredEvent;

export interface AgentTraceActiveBrowserSession {
  id: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
}

export interface AgentTraceResponse {
  success: boolean;
  id?: string;
  events?: AgentTraceEvent[];
  creditsUsed?: number;
  /** Present only when the trace was requested with liveView: true. */
  activeBrowserSessions?: AgentTraceActiveBrowserSession[];
  error?: string;
}

export interface AgentSnapshotResponse {
  success: boolean;
  id?: string;
  snapshotId?: string;
  /** Full artifact content as a JSON/string blob. */
  snapshot?: string;
  error?: string;
}

export interface AgentOptions {
  model: "FIRE-1" | "v3-beta";
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
    jobId?: string,
  ) {
    super(message);
    this.name = "FirecrawlSdkError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.jobId = jobId;
  }
}

export class JobTimeoutError extends SdkError {
  timeoutSeconds: number;
  constructor(
    jobId: string,
    timeoutSeconds: number,
    jobType: "batch" | "crawl" = "batch",
  ) {
    const jobTypeLabel = jobType === "batch" ? "batch scrape" : "crawl";
    super(
      `${jobTypeLabel.charAt(0).toUpperCase() + jobTypeLabel.slice(1)} job ${jobId} did not complete within ${timeoutSeconds} seconds`,
      undefined,
      "JOB_TIMEOUT",
      undefined,
      jobId,
    );
    this.name = "JobTimeoutError";
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
  cdpUrl?: string;
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

// ---------- Research (v2) ----------

/**
 * Source identifiers grouped by namespace. Each key is a namespace and each
 * value is an array of ids in that namespace.
 *
 * Which namespaces appear depends on the paper's source. Biomedical records
 * (PubMed, bioRxiv, medRxiv) typically carry `pmid`, `pmcid` and/or `doi`;
 * arXiv records carry `arxiv`. The set is open — treat this as a lookup by
 * namespace rather than a fixed schema, and prefer {@link PaperResult.primaryId}
 * when you just need one citable identifier.
 *
 * @example
 * ```ts
 * const doi = paper.ids?.doi?.[0];
 * const pmid = paper.ids?.pmid?.[0];
 * ```
 */
export type IdMap = Record<string, string[]>;

/** Per-candidate ranking signals (present on similarity results). */
export interface PaperSignals {
  /** Raw structural strength (co-citation / coupling counts, or seed overlap). */
  structural: number;
  /** Semantic score from the intent abstract search (0 if absent). */
  semantic: number;
  /** Citation-graph article-rank score of the candidate. */
  articleRank: number;
  /** Number of distinct seeds connected to this candidate. */
  seedOverlap: number;
}

/** A ranked paper. `paperId` is canonical; source ids (pmid, pmcid, doi, arxiv, ...) live in `ids`. */
export interface PaperResult {
  /** Canonical paper id — the Milvus INT64 primary key as a decimal string. */
  paperId: string;
  /** Preferred cite/fetch identifier such as `arxiv:<id>`, `pmid:<id>`, or `doi:<id>`. */
  primaryId: string;
  ids?: IdMap;
  title: string;
  abstract: string;
  /** Final ranking score (post-rerank when enabled). Not normalized. */
  score: number;
  /** Present on similarity results. */
  signals?: PaperSignals;
}

export interface PaperMetadata {
  paperId: string;
  ids?: IdMap;
  title: string;
  abstract: string;
  /** Comma-joined author names. Omitted if unknown. */
  authors?: string;
  /** arXiv categories. Omitted if unknown. */
  categories?: string[];
  /** Original creation date string (format varies). Omitted if unknown. */
  createdDate?: string;
  /** Last-updated date string. Omitted if unknown. */
  updateDate?: string;
}

export interface Passage {
  /** In-body passage text (may be markdown, including tables). */
  text: string;
  /** Dense similarity score for the passage. */
  score: number;
}

export interface SearchPapersResponse {
  success: boolean;
  results: PaperResult[];
}

export interface PaperMetadataResponse {
  success: boolean;
  paper: PaperMetadata;
}

export interface ReadPaperResponse {
  success: boolean;
  paper: PaperMetadata;
  /** Resolved canonical paper id (empty string if not found via id-key). */
  paperId: string;
  /** Echo of the read query. */
  query: string;
  /** Top matching in-body passages. */
  passages: Passage[];
}

export interface SimilarPapersResponse {
  success: boolean;
  /** Ranked related papers; each carries `signals`. */
  results: PaperResult[];
  /** Number of resolved candidates considered before truncation to `k`. */
  poolSize: number;
  /** True if more resolved candidates existed than were returned. */
  truncated: boolean;
  /** Human-readable note when no results are produced. */
  note?: string | null;
}

/** Component scores; each field is present only when that signal contributed. */
export interface GitHubScoreBreakdown {
  rrf?: number;
  semantic?: number;
  lexical?: number;
  fusion?: number;
  rerank?: number;
}

export interface GitHubSearchItem {
  resultType?: "github_history" | "repo_readme" | "web";
  /** `owner/name`; empty for web results whose URL is not a repo page. */
  repo: string;
  url: string;
  /** History page type (e.g. `issue`, `pull`). Omitted for readmes. */
  pageType?: string;
  /** Issue/PR number. Omitted for readmes. */
  number?: number;
  /** Number of matched segments/chunks. Omitted when not applicable. */
  segmentCount?: number;
  /** Readme URL (readme results). Omitted otherwise. */
  readmeUrl?: string;
  /** SERP page title. Only set on web results. */
  title?: string;
  /** Short matched excerpt. */
  snippet: string;
  /** Full matched content in markdown. Omitted unless available. */
  contentMd?: string;
  scores: GitHubScoreBreakdown;
}

export interface GitHubSearchResponse {
  success: boolean;
  results: GitHubSearchItem[];
}

/** Options for `research.searchPapers`. */
export interface SearchPapersOptions {
  /** Number of results to return (1–500, default 40). */
  k?: number;
  /** Author substring filter(s); ALL must match (case-insensitive). */
  authors?: string[];
  /** arXiv category filter(s) (e.g. `cs.LG`); ALL must match. */
  categories?: string[];
  /** Inclusive lower bound on created/updated date (ISO `YYYY-MM-DD`). */
  from?: string;
  /** Inclusive upper bound on created/updated date (lexicographic). */
  to?: string;
}

/** Options for `research.getPaper`. */
export interface GetPaperOptions {
  /** When present, switches to read mode and returns in-body passages. */
  query?: string;
  /** Passage count (read mode only; 1–50, default 4). Requires `query`. */
  k?: number;
}

/** Options for `research.similarPapers`. */
export interface SimilarPapersOptions {
  /** Natural-language intent used to semantically rerank candidates. Required. */
  intent: string;
  /** Traversal mode (default `similar`). */
  mode?: "similar" | "citers" | "references";
  /** Number of related papers to return (1–500, default 40). */
  k?: number;
  /** Apply an additional ZeroEntropy rerank over the fused candidates. */
  rerank?: boolean;
  /** Additional seed paper reference(s), same format as `id`. */
  anchor?: string[];
}

/** Options for `research.searchGithub`. */
export interface SearchGithubOptions {
  /** Number of results to return (1–100, default 20). */
  k?: number;
}
