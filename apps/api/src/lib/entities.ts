import type { Action } from "../controllers/v1/types";
import type { BrandingProfile } from "../types/branding";

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
    javascriptReturns?: {
      type: string;
      value: unknown;
    }[];
    pdfs?: string[];
  };
  branding?: BrandingProfile;

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

interface ImageSearchResult {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  url?: string;
  position?: number;
  answer?: string;
  highlights?: string;
}

interface NewsSearchResult {
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
  answer?: string;
  highlights?: string;
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
  answer?: string;
  highlights?: string;
}

export type SearchResultType = "web" | "images" | "news";

export interface SearchV2Response {
  web?: WebSearchResult[];
  images?: ImageSearchResult[];
  news?: NewsSearchResult[];
}

/**
 * Length of each `SearchV2Response` group as returned to the client. Every
 * group is present and non-negative — a source that was not requested, or that
 * returned nothing, counts 0. Persisted per search so position-based feedback
 * can be bounded exactly per source rather than against a combined total.
 */
export type SearchResultCountsBySource = Record<SearchResultType, number>;

export function countSearchResultsBySource(
  response: SearchV2Response,
): SearchResultCountsBySource {
  return {
    web: response.web?.length ?? 0,
    images: response.images?.length ?? 0,
    news: response.news?.length ?? 0,
  };
}

/**
 * Which vertical produced each result, keyed by group and then by the result's
 * 1-indexed position in that group: `{"web":{"1":"developer","3":"github"}}`.
 *
 * Sparse on purpose. Results carry a `category` only when one applies — the
 * developer index stamps `developer` on every hit it serves (see
 * `search/developer.ts`), and `github` / `research` / `pdf` are derived per URL
 * in `search/execute.ts` — so untagged results are simply absent, as are groups
 * with no tagged results at all. An empty object therefore means "nothing was
 * tagged", which is a different claim from a NULL column ("this row predates
 * the column").
 *
 * This is the only place the serving vertical survives the response. `source`
 * says which `data` group a result sits in, which is addressing; `category`
 * says who answered, which is attribution. They are the same value today only
 * because the developer category is schema-enforced as exclusive and lands in
 * `data.web`; blend a vertical into ordinary web results and the two come
 * apart. Persisted per search so position-based feedback can resolve the
 * vertical behind a `(source, position)` pair it is handed later.
 */
export type SearchResultCategoriesBySource = Partial<
  Record<SearchResultType, Record<string, string>>
>;

export function collectSearchResultCategories(
  response: SearchV2Response,
): SearchResultCategoriesBySource {
  const collected: SearchResultCategoriesBySource = {};

  for (const source of ["web", "images", "news"] as const) {
    const results = response[source];
    if (!results?.length) continue;

    const categories: Record<string, string> = {};
    results.forEach((result, index) => {
      const category = (result as { category?: unknown }).category;
      if (typeof category === "string" && category.length > 0) {
        categories[String(index + 1)] = category;
      }
    });

    if (Object.keys(categories).length > 0) {
      collected[source] = categories;
    }
  }

  return collected;
}

export interface ScrapeActionContent {
  url: string;
  html: string;
}
