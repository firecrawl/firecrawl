/*
 * Unstable internal bridge exporting route middleware, worker primitives, and
 * shared helpers for legacy API route and worker extensions while those
 * helpers still live in this package. Not imported by `./service/index`, so
 * constructing or describing a service never loads these dependencies.
 */

export { config } from "../../config";
export { startRole } from "../../main";
export { shutdownTracing } from "../../otel";
export { RateLimiterMode } from "../../types";
export type { ScrapeJobData, ScrapeJobSingleUrls } from "../../types";

export { getACUCTeam, getApiKeyTeamFlags } from "../../controllers/auth";
export {
  livenessController,
  readinessController,
} from "../../controllers/health";
export {
  OPENAI_SCHEMA_ERROR_MESSAGE,
  URL,
  baseScrapeOptions,
  crawlerOptions,
  extractTransform,
  getV2RequestSchemas,
  normalizeSchemaForOpenAI,
  scrapeOptions,
  toV0CrawlerOptions,
  toV2CrawlerOptions,
  validateSchemaForOpenAI,
  waitForRefine,
  waitForRefineOpts,
} from "../../controllers/v2/types";
export type {
  Action,
  AuthCreditUsageChunk,
  CrawlerOptions,
  Document,
  ErrorResponse,
  InternalAction,
  JsonFormatWithOptions,
  RequestWithAuth,
  ScrapeOptions,
  TeamFlags,
  TokenUsage,
} from "../../controllers/v2/types";

export { db, dbRr } from "../../db/connection";
export * as dbSchema from "../../db/schema";

export { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
export type { AgentInteropStatus } from "../../lib/agent-interop";
export { ZDR_EXPIRED_ERROR, agentJobExpiry } from "../../lib/agent-job-expiry";
export { aiTelemetry } from "../../lib/ai-telemetry";
export { normalizeUrl } from "../../lib/canonical-url";
export {
  cleanOldConcurrencyLimitEntries,
  cleanOldConcurrencyLimitedJobs,
  getConcurrencyLimitActiveJobsCount,
  getConcurrencyLimitedJobs,
  getConcurrencyQueueJobsCount,
  removeConcurrencyLimitedJobs,
} from "../../lib/concurrency-limit";
export { CostTracking } from "../../lib/cost-tracking";
export {
  addCrawlJob,
  addCrawlJobs,
  crawlToCrawler,
  finishCrawlKickoff,
  getCrawl,
  getCrawlError,
  getCrawlExpiry,
  getCrawlJobs,
  getCrawlQualifiedJobCount,
  getDoneJobsOrdered,
  getDoneJobsOrderedLength,
  getDoneJobsOrderedUntil,
  isCrawlKickoffFinished,
  lockURL,
  lockURLs,
  markCrawlActive,
  saveCrawl,
  type StoredCrawl,
} from "../../lib/crawl-redis";
export { addPathRegexIssues, pathPatternsSchema } from "../../lib/crawl-regex";
export { getErrorContactMessage, isSelfHosted } from "../../lib/deployment";
export { SearchResult } from "../../lib/entities";
export type {
  Document as V0Document,
  ExtractorOptions,
  PageOptions,
  ScrapeActionContent,
  SearchOptions,
  SearchV2Response,
} from "../../lib/entities";
export { deserializeTransportableError } from "../../lib/error-serde";
export {
  MapTimeoutError,
  ScrapeJobTimeoutError,
  TransportableError,
  UnsupportedSiteError,
  isTransportableError,
  type ErrorCode,
} from "../../lib/error";
export { ThirdPartyDataTermsRequiredError } from "../../lib/exchange";
export { externalRequestId } from "../../lib/external-request-id";
export {
  ExtractV3AgentStatusError,
  getExtractV3AgentStatus,
} from "../../lib/extract-v3-status";
export { includesFormat } from "../../lib/format-utils";
export type { FreshFeedFilters, FreshFeedUpstream } from "../../lib/fresh-feed";
export { getJobFromGCS } from "../../lib/gcs-jobs";
export { getModel } from "../../lib/generic-ai";
export { claimIdempotencyKey } from "../../lib/idempotency";
export {
  JOB_ACCESS_TTL_MS,
  normalizeJobAccessTeamId,
  writeApiJobAccess,
} from "../../lib/job-access-store";
export { jobDurationSeconds } from "../../lib/job-metrics";
export { getJobPriority } from "../../lib/job-priority";
export {
  readExtractJobState,
  readScrapeJobState,
} from "../../lib/job-state-store";
export {
  actionTypesOf,
  checkKeyFormatRestriction,
  formatTypesOf,
} from "../../lib/key-restriction";
export {
  projectScrapeCredits,
  projectSearchTotalCredits,
} from "../../lib/keyless-credit-projection";
export {
  adjustKeylessCredits,
  keylessLimitBody,
  keylessProviderToolsBody,
  logKeylessCreditUsage,
  reserveKeylessCredits,
} from "../../lib/keyless";
export { currentLimits } from "../../lib/limits";
export { logger } from "../../lib/logger";
export { performCosineSimilarity } from "../../lib/map-cosine";
export { queryIndex } from "../../lib/map-query-index";
export { modelPrices } from "../../lib/model-prices";
export { startNodeRuntimeMetrics } from "../../lib/node-runtime-metrics";
export { addStrictSchemaIssue } from "../../lib/openai-strict-schema";
export {
  getCrawlJobAccess,
  getExtractJobAccess,
  getScrapeJobAccess,
} from "../../lib/operational-job-access";
export {
  SpanKind,
  recordSpanException,
  setSpanAttributes,
  withSpan,
  type Span,
} from "../../lib/otel-tracer";
export { checkPermissions, ipWhitelistRefusal } from "../../lib/permissions";
export {
  requestContext,
  storedZeroDataRetention,
} from "../../lib/request-context";
export { readRequestCreditsFromAnalytics } from "../../lib/request-credits-analytics";
export {
  readRequestCredits,
  requestCreditsShards,
} from "../../lib/request-credits-store";
export { requestOrigin } from "../../lib/request-origin";
export {
  SAFE_MODE_V0_UNSUPPORTED_MESSAGE,
  applySafeMode,
  getEffectiveSearchForcedKind,
  getSafeMode,
  isLockdownZeroDataRetention,
  resolveSafeMode,
} from "../../lib/safe-mode";
export { calculateThreatScanCredits } from "../../lib/scrape-billing";
export { timingSafeSecretEqual } from "../../lib/secret-compare";
export {
  emitRejectedScrapeActivityEvent,
  emitRejectedScrapeActivityEvents,
} from "../../lib/siem-logging/index";
export { auditMetadataSchema } from "../../lib/siem-logging/types";
export { UNSUPPORTED_SITE_MESSAGE } from "../../lib/strings";
export { orgIdFromAcuc } from "../../lib/team-org";
export { teamPlanClass, type TeamPlanClass } from "../../lib/team-plan-class";
export { threatProtectionOverrideSchema } from "../../lib/threat-protection/config";
export { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
export { checkUrl as checkThreatUrl } from "../../lib/threat-protection/index";
export {
  THREAT_PROTECTION_V0_UNSUPPORTED_MESSAGE,
  checkUrlsAgainstThreatPolicy,
  isThreatProtectionForced,
  resolveThreatProtection,
} from "../../lib/threat-protection/request";
export type { ThreatProtectionPolicy } from "../../lib/threat-protection/types";
export { trackSearchRequest } from "../../lib/tracking";
export { hasReachableHost } from "../../lib/url-utils";
export { isUsOnly, usOnlyLocationRefusal } from "../../lib/us-only";
export { countries } from "../../lib/validate-country";
export {
  checkAndUpdateURL,
  checkAndUpdateURLForMap,
  checkUrl,
  isSameDomain,
  isSameSubdomain,
  protocolIncluded,
  removeDuplicateUrls,
} from "../../lib/validateUrl";
export { withAuth } from "../../lib/withAuth";
export {
  getScrapeZDR,
  getSearchForcedKind,
  getSearchZDR,
} from "../../lib/zdr-helpers";
export type { ZDRPolicy } from "../../lib/zdr-policy";

export {
  authMiddleware,
  blocklistMiddleware,
  checkCreditsMiddleware,
  idempotencyMiddleware,
  inferIntegrationMiddleware,
  requestTimingMiddleware,
  restrictedOptionsCountryCheck,
  scrapeBlocklistMiddleware,
  validateJobIdParam,
  wrap,
} from "../../routes/shared";

export { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";
export type { InternalOptions } from "../../scraper/scrapeURL/index";
export { AbortManagerThrownError } from "../../scraper/scrapeURL/lib/abortManager";
export {
  generateCompletions,
  trimToTokenLimit,
} from "../../scraper/scrapeURL/transformers/llmExtract";
export { initializeEngineForcing } from "../../scraper/WebScraper/utils/engine-forcing";
export { getURLDepth } from "../../scraper/WebScraper/utils/maxDepthUtils";

export { executeSearch } from "../../search/execute";
export { fireEngineMap } from "../../search/fireEngine";
export { applySearchPlanHook } from "../../search/plan-hook";
export {
  scrapeSearchResults,
  type DocumentWithCostTracking,
} from "../../search/scrape";
export { search as searchV2 } from "../../search/v2/index";

export { installedService, runProcessStop } from "../../service/service";
export type { SearchRequest as ServiceSearchRequest } from "../../service/request";

export {
  DEFAULT_TEAM_LIMITS,
  SEARCH_CREDITS_FEATURE_ID,
  autumnService,
} from "../../services/autumn/autumn.service";
export {
  TOKENS_PER_CREDIT,
  getTeamBalance,
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
  toTokenPeriods,
  toTokenPeriodsByApiKey,
} from "../../services/autumn/usage";
export { billTeam } from "../../services/billing/credit_billing";
export {
  logDeepResearch,
  logExtract,
  logLlmsTxt,
  logMap,
  logRequest,
  logSearch,
  shutdownPubSubLogging,
} from "../../services/logging/log_job";
export {
  _addScrapeJobToBullMQ,
  addScrapeJob,
  addScrapeJobs,
  waitForJob,
} from "../../services/queue-jobs";
export { getRedisConnection } from "../../services/queue-service";
export { redisEvictConnection } from "../../services/redis";
export { default as systemMonitor } from "../../services/system-monitor";
export {
  WebhookEvent,
  createWebhookSender,
} from "../../services/webhook/index";
export { webhookSchema } from "../../services/webhook/schema";
export {
  nuqFdbHealthCheck,
  scrapeQueueFdb,
  withFdbTimeout,
} from "../../services/worker/nuq-fdb/index";
export {
  crawlGroup,
  getCombinedTeamActiveCount,
  isFdbTeam,
  resolveNewGroupBackend,
  scrapeQueue,
  type NuQJob,
  type NuQJobStatus,
} from "../../services/worker/nuq-router";
export { processJobInternal } from "../../services/worker/scrape-worker";
export { teamConcurrencySemaphore } from "../../services/worker/team-semaphore";

export { integrationSchema, resolveIntegration } from "../../utils/integration";
