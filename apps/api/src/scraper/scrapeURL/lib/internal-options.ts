import { ScrapeOptions as ScrapeOptionsV1 } from "../../../controllers/v1/types";
import { TeamFlags } from "../../../controllers/v2/types";
import { AbortInstance } from "./abortManager";

export type InternalOptions = {
  teamId: string;
  crawlId?: string;

  priority?: number; // Passed along to fire-engine
  forceEngine?: unknown; // Compatibility shim for old internal callers; ignored by scrapeURL.
  atsv?: boolean; // anti-bot solver, beta

  v0CrawlOnlyUrls?: boolean;
  v0DisableJsDom?: boolean;
  disableSmartWaitCache?: boolean; // Passed along to fire-engine
  isBackgroundIndex?: boolean;
  externalAbort?: AbortInstance;
  urlInvisibleInCurrentCrawl?: boolean;
  unnormalizedSourceURL?: string;

  saveScrapeResultToGCS?: boolean; // Passed along to fire-engine
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
  teamFlags?: TeamFlags;

  v1Agent?: ScrapeOptionsV1["agent"];
  v1JSONAgent?: Exclude<ScrapeOptionsV1["jsonOptions"], undefined>["agent"];
  v1JSONSystemPrompt?: string;
  v1OriginalFormat?: "extract" | "json"; // Track original v1 format for backward compatibility

  isPreCrawl?: boolean; // Whether this scrape is part of a precrawl job
  agentIndexOnly?: boolean; // Pre-confirmation agent key: serve from index only, never touch web/Fire Engine
  isParse?: boolean; // Whether this scrape originated from /v2/parse
};
