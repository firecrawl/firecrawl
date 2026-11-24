/*
 * Unstable internal admin route helpers exposed through lazy async loaders so
 * importing this entry point never loads configuration, queues, or database
 * clients until a route extension invokes a loader at runtime.
 */
export type { RequestWithAuth } from "../../controllers/v2/types";
export type { AdminKeySlot } from "../../lib/admin-auth";
export type { StoredCrawl } from "../../lib/crawl-redis";
export type { SearchRequest } from "../../lib/search-index-client";

async function importAdminAuthHelpers() {
  const {
    ADMIN_KEY_HEADER,
    adminAuth,
    adminKeyHeaderAuth,
    adminPathKeyAuth,
    bearerToken,
    secretsMatch,
  } = await import("../../lib/admin-auth.js");

  return {
    ADMIN_KEY_HEADER,
    adminAuth,
    adminKeyHeaderAuth,
    adminPathKeyAuth,
    bearerToken,
    secretsMatch,
  };
}

let adminAuthHelpersPromise:
  | ReturnType<typeof importAdminAuthHelpers>
  | undefined;

/** Lazily loads admin key authentication helpers and header/path middlewares. */
export function loadAdminAuthHelpers() {
  return (adminAuthHelpersPromise ??= importAdminAuthHelpers());
}

async function importAdminRouteMiddleware() {
  const [
    { authMiddleware, checkCreditsMiddleware, wrap },
    { RateLimiterMode },
  ] = await Promise.all([
    import("../../routes/shared.js"),
    import("../../types.js"),
  ]);

  return {
    authMiddleware,
    checkCreditsMiddleware,
    wrap,
    RateLimiterMode,
  };
}

let adminRouteMiddlewarePromise:
  | ReturnType<typeof importAdminRouteMiddleware>
  | undefined;

/** Lazily loads shared auth, credit-check, and async handler wrappers. */
export function loadAdminRouteMiddleware() {
  return (adminRouteMiddlewarePromise ??= importAdminRouteMiddleware());
}

async function importAdminCacheHelpers() {
  const [
    { clearACUC, clearACUCTeam },
    { clearIpRestrictionCache },
    { clearKeyRestrictionCache },
  ] = await Promise.all([
    import("../../controllers/auth.js"),
    import("../../lib/ip-restriction.js"),
    import("../../lib/key-restriction.js"),
  ]);

  return {
    clearACUC,
    clearACUCTeam,
    clearIpRestrictionCache,
    clearKeyRestrictionCache,
  };
}

let adminCacheHelpersPromise:
  | ReturnType<typeof importAdminCacheHelpers>
  | undefined;

/** Lazily loads cache-invalidation helpers used by admin cache-clear routes. */
export function loadAdminCacheHelpers() {
  return (adminCacheHelpersPromise ??= importAdminCacheHelpers());
}

async function importAdminQueueHelpers() {
  const [
    { getIndexInsertQueueLength, getOMCEQueueLength },
    { getWebhookInsertQueueLength },
    { getPrecrawlQueue },
  ] = await Promise.all([
    import("../../services/index.js"),
    import("../../services/webhook/index.js"),
    import("../../services/queue-service.js"),
  ]);

  return {
    getIndexInsertQueueLength,
    getOMCEQueueLength,
    getWebhookInsertQueueLength,
    getPrecrawlQueue,
  };
}

let adminQueueHelpersPromise:
  | ReturnType<typeof importAdminQueueHelpers>
  | undefined;

/** Lazily loads queue depth and enqueue helpers used by admin queue routes. */
export function loadAdminQueueHelpers() {
  return (adminQueueHelpersPromise ??= importAdminQueueHelpers());
}

async function importAdminSearchHelpers() {
  const [{ getSearchIndexClient }, { CostTracking }] = await Promise.all([
    import("../../lib/search-index-client.js"),
    import("../../lib/cost-tracking.js"),
  ]);

  return {
    getSearchIndexClient,
    CostTracking,
  };
}

let adminSearchHelpersPromise:
  | ReturnType<typeof importAdminSearchHelpers>
  | undefined;

/** Lazily loads search-index client and cost-tracking helpers. */
export function loadAdminSearchHelpers() {
  return (adminSearchHelpersPromise ??= importAdminSearchHelpers());
}

async function importCrawlMonitorHelpers() {
  const [
    { crawlerOptions, scrapeOptions, toV0CrawlerOptions },
    { logRequest },
    { crawlToCrawler, markCrawlActive, saveCrawl },
    { crawlGroup, resolveNewGroupBackend },
    { _addScrapeJobToBullMQ },
    { requestCreditsShards },
  ] = await Promise.all([
    import("../../controllers/v2/types.js"),
    import("../../services/logging/log_job.js"),
    import("../../lib/crawl-redis.js"),
    import("../../services/worker/nuq-router.js"),
    import("../../services/queue-jobs.js"),
    import("../../lib/request-credits-store.js"),
  ]);

  return {
    crawlerOptions,
    scrapeOptions,
    toV0CrawlerOptions,
    logRequest,
    crawlToCrawler,
    markCrawlActive,
    saveCrawl,
    crawlGroup,
    resolveNewGroupBackend,
    _addScrapeJobToBullMQ,
    requestCreditsShards,
  };
}

let crawlMonitorHelpersPromise:
  | ReturnType<typeof importCrawlMonitorHelpers>
  | undefined;

/** Lazily loads crawl scheduling and group-polling helpers. */
export function loadCrawlMonitorHelpers() {
  return (crawlMonitorHelpersPromise ??= importCrawlMonitorHelpers());
}
