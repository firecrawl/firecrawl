/*
 * Type augmentations for billing state carried between controllers, workers,
 * and custom billing module implementations. Imports only types.
 */
import type { RequestWithAuth } from "../controllers/v2/types";
import type { ScrapeOptions } from "../controllers/v2/types";
import type { InternalOptions } from "../scraper/scrapeURL";
import type { FeatureFlag } from "../scraper/scrapeURL/engines";

declare module "../service/modules" {
  interface AuthorizeState {
    /**
     * Express request carried for preflight and reservation checks.
     * A billing module may update request auth flags (such as `hostedMcp` or `agentIndexOnly`) during preflight.
     */
    req?: RequestWithAuth<any, any, any>;
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
    categories?: unknown[];
    /** Requested search sources for search reservations. */
    sources?: unknown[];
    /** Whether domain tool discovery was requested for search reservations. */
    domainTools?: boolean;
    /** Enterprise search modes requested. */
    enterprise?: ("default" | "anon" | "zdr")[];
    /** Scrape options for scrape, parse, or scrapeful search reservations. */
    scrapeOptions?: ScrapeOptions;
    /** Route identifier for reservation refusal responses. */
    endpoint?: "v2_scrape" | "v2_parse" | "v2_search";
  }

  interface SearchChargeState {
    enterprise?: ("default" | "anon" | "zdr")[];
    threatDecisions?: unknown[];
    [key: string]: unknown;
  }

  interface MapChargeState {
    perUrl?: boolean;
    chargeId?: string;
    threatDecisions?: unknown[];
  }

  interface CrawlChargeState {
    crawlerOptions?: unknown;
    chargeId?: string;
    resolveOrgFromTeam?: boolean;
    threatDecisions?: unknown[];
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
    exchange?: Record<string, unknown>;
    threatDecisions?: unknown[];
  }
}
