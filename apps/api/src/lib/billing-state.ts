/*
 * Type augmentations for billing state carried between controllers, workers,
 * and custom billing module implementations. Imports only types.
 */
import type { Request } from "express";
import type {
  AuthCreditUsageChunk,
  RequestWithAuth,
  ScrapeOptions,
} from "../controllers/v2/types";
import type { WebSearchResult } from "./entities";
import type { JsonObject } from "./json-types";
import type { InternalOptions } from "../scraper/scrapeURL";
import type { FeatureFlag } from "../scraper/scrapeURL/engines";
import type { ScrapeJobSingleUrls } from "../types";

declare module "../service/modules" {
  interface AuthorizeState {
    /**
     * Express request carried for preflight and reservation checks.
     * A billing module may update request auth flags (such as `hostedMcp` or `agentIndexOnly`) during preflight.
     */
    req?: Request & {
      auth?: RequestWithAuth["auth"];
      acuc?: AuthCreditUsageChunk | null;
    };
    /** Explicit minimum units configured on the route middleware. */
    minimum?: number;
    /** Optional metering feature identifier configured on the route. */
    featureId?: string;
    /** Whether the route may meter against MCP credits. */
    mcpCredits?: boolean;
    /** Whether the request should be billed (false for non-billed internal calls). */
    shouldBill?: boolean;
    /** Whether the request uses a preview token. */
    isPreview?: boolean;
    /** Whether the search targets free catalogue sources only. */
    freeCatalogue?: boolean;
    /** Whether the search includes the gov category. */
    govSearch?: boolean;
    /** Whether scrape formats were requested alongside a search. */
    hasScrapeFormats?: boolean;
    /** Requested result count for search reservations. */
    limit?: number;
    /** Requested search categories for search reservations. */
    categories?: Array<unknown>;
    /** Requested search sources for search reservations. */
    sources?: Array<unknown>;
    /** Whether domain tool discovery was requested for search reservations. */
    domainTools?: boolean;
    /** Enterprise search modes requested. */
    enterprise?: Array<"default" | "anon" | "zdr">;
    /** Scrape options for scrape, parse, or scrapeful search reservations. */
    scrapeOptions?: ScrapeOptions;
    /** Route identifier for reservation refusal responses. */
    endpoint?: "v2_scrape" | "v2_parse" | "v2_search";
  }

  interface SearchChargeState {
    enterprise?: Array<"default" | "anon" | "zdr">;
    threatDecisions?: Array<unknown>;
    routedResults?: Array<unknown>;
    toolsOnly?: boolean;
    toolsUnavailable?: boolean;
    nonBillableResultsCount?: number;
    indexResultsCount?: number;
  }

  interface MapChargeState {
    perUrl?: boolean;
    chargeId?: string;
    threatDecisions?: Array<unknown>;
  }

  interface CrawlChargeState {
    crawlerOptions?: unknown;
    chargeId?: string;
    resolveOrgFromTeam?: boolean;
    threatDecisions?: Array<unknown>;
  }
}

declare module "../service/hooks" {
  interface ScrapeState {
    internalOptions?: InternalOptions;
    crawlId?: string;
    crawlerOptions?: unknown;
    keylessReserved?: boolean;
    error?: Error | null;
    unsupportedFeatures?: Set<FeatureFlag>;
    exchange?: JsonObject;
    threatDecisions?: Array<unknown>;
  }

  interface ScrapeFinishedMetadata {
    jobData?: ScrapeJobSingleUrls;
    exchange?: JsonObject;
    threatDecisions?: Array<unknown>;
  }

  interface MapState {
    skipDiscovery?: boolean;
    skipScope?: boolean;
    skipCosine?: boolean;
    threatDecisions?: Array<unknown>;
    filtered?: boolean;
  }

  interface SearchState {
    routedResults?: Array<WebSearchResult>;
    toolsOnly?: boolean;
    toolsUnavailable?: boolean;
    threatDecisions?: Array<unknown>;
    nonBillableResultsCount?: number;
    indexResultsCount?: number;
    indexCategory?:
      | string
      | {
          table: string;
          indexResultsCount?: number;
        };
  }
}
