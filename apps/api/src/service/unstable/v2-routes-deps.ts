/*
 * Unstable internal bridge exporting route middleware and shared helper
 * primitives for v2 route extensions while those helpers still live in this
 * package. Not imported by `./service/index`, so constructing or describing
 * a service never loads these dependencies.
 */

export { emptyStringAsUndefined } from "../../config-helpers";
export { RateLimiterMode } from "../../types";
export {
  authMiddleware,
  blocklistMiddleware,
  checkCreditsMiddleware,
  countryCheck,
  inferIntegrationMiddleware,
  requestTimingMiddleware,
  restrictedOptionsCountryCheck,
  validateJobIdParam,
  wrap,
} from "../../routes/shared";

export { keylessClientIp } from "../../controllers/auth";
export type {
  ErrorResponse as V1ErrorResponse,
  RequestWithAuth as V1RequestWithAuth,
} from "../../controllers/v2/types";
export {
  AGENT_DEFAULT_MAX_CREDITS,
  gateAgentCredits,
} from "../../controllers/v2/agent-credit-gate";
export { countryLocationSchema, URL } from "../../controllers/v2/types";
export type {
  ErrorResponse,
  RequestWithAuth,
  ScrapeOptions,
  TeamFlags,
} from "../../controllers/v2/types";

export {
  agentConsumeFreeRequestIfLeft,
  authCreditUsageChunkFromTeam,
} from "../../db/rpc";

export { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
export { isAgentInteropSecretValid } from "../../lib/agent-interop";
export { ZDR_EXPIRED_ERROR, agentJobExpiry } from "../../lib/agent-job-expiry";
export { aiTelemetry } from "../../lib/ai-telemetry";
export { alexandriaFeedbackStorage } from "../../lib/alexandria-feedback-storage";
export { billingCountryForTeam } from "../../lib/billing-country";
export {
  BrowserSessionError,
  browserSessionLinks,
  createBrowserSession,
  getBrowserZDR,
  invalidAgentInteropError,
  reserveBrowserPromptCredits,
  settleBrowserSession,
  stopBrowserSession,
} from "../../lib/browser-lifecycle";
export {
  browserOptionsFromScrape,
  type BrowserOptions,
} from "../../lib/browser-options";
export { browserProfileNameSchema } from "../../lib/browser-profiles";
export { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
export {
  deleteBrowserProfile,
  getBrowserSession,
  getBrowserSessionFromScrape,
  listActiveBrowserSessionsForRequest,
  listBrowserSessions,
  updateBrowserSessionActivity,
  updateBrowserSessionScrapeId,
} from "../../lib/browser-sessions";
export { clickhouseClient } from "../../lib/clickhouse-client";
export { removedEndpointHandler } from "../../lib/deprecations";
export {
  developerCategoryAliases,
  isDeveloperCategoryAlias,
} from "../../lib/developer-category";
export type {
  SearchResultType,
  SkillCard,
  WebSearchResult,
} from "../../lib/entities";
export type { ErrorCode } from "../../lib/error";
export { forwardExchangeToolFeedback } from "../../lib/exchange";
export { externalRequestId } from "../../lib/external-request-id";
export {
  ExtractV3AgentStatusError,
  agentStatusUnavailable,
  getExtractV3AgentStatus,
} from "../../lib/extract-v3-status";
export { feedbackEnv } from "../../lib/feedback-env";
export {
  readFeedbackJob,
  type RefundClass,
} from "../../lib/feedback-job-store";
export {
  feedbackTrace,
  lineageIds,
  type FeedbackTrace,
} from "../../lib/feedback-trace";
export {
  FRESH_FEED_COLLECTION_HEADER,
  FRESH_FEED_FILTER_KEYS,
  FRESH_FEED_UPSTREAMS,
  FRESH_FEED_UPSTREAM_ROUTES,
  MAX_FRESH_FEED_AGENTS,
  freshFeedUpstreamPath,
  getFreshFeedUpstreams,
  hasFreshFeedUpstreams,
  isFreshFeedUpstream,
  isValidFreshFeedAgentToken,
  isValidFreshFeedCollection,
  normalizeFreshFeedHostToken,
  normalizeFreshFeedUpstreams,
  parseFreshFeedFilters,
  resolveFreshFeedVertical,
  type FreshFeedFilterKey,
  type FreshFeedFilters,
  type FreshFeedUpstream,
  type FreshFeedUpstreamEnv,
  type FreshFeedUpstreamRouteDefinition,
  type FreshFeedUpstreamUrls,
  type FreshFeedVerticalTarget,
} from "../../lib/fresh-feed";
export { getMonitorDiffArtifact } from "../../lib/gcs-monitoring";
export { getModel } from "../../lib/generic-ai";
export {
  HangarError,
  deleteHangarProfile,
  executeHangarBrowser,
  getHangarBrowser,
  getHangarRecording,
  type BrowserExecutionResult,
} from "../../lib/hangar";
export {
  getRoutePattern,
  httpRequestDurationSeconds,
} from "../../lib/http-metrics";
export {
  consumeIndexRateLimit,
  indexDailyLimitRefusal,
  reserveIndexCalls,
  type IndexName,
} from "../../lib/index-daily-limit";
export { readScrapeJobState } from "../../lib/job-state-store";
export { checkKeyFormatRestriction } from "../../lib/key-restriction";
export {
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  chargeKeylessCredits,
  checkKeylessEligibility,
  isKeylessIpEligible,
  keylessLimitBody,
  keylessLimitPromptForTeam,
  keylessProviderToolsBody,
  keylessSignupUrlForIp,
  keylessTeamUuid,
  keylessWorldIdIdentity,
  normalizeKeylessIpv4,
  reportKeylessPromptShown,
} from "../../lib/keyless";
export {
  keylessFallbackSignupUrl,
  keylessSignupSurface,
  type KeylessPromptReason,
} from "../../lib/keyless-signup-link";
export {
  LINEAGE_ID_PATTERN,
  LINEAGE_ID_SECRET_PATTERN,
  OBJECTIVE_MAX_LENGTH,
  SECRET_PATTERN,
  SECRET_PATTERN_ALL,
  SESSION_SOURCES,
  THREAD_SOURCES,
  redactText,
} from "../../lib/mcp-lineage";
export {
  getAgentJobAccess,
  getScrapeJobAccess,
} from "../../lib/operational-job-access";
export {
  recordSpanException,
  setSpanAttributes,
  withSpan,
  withZeroDataRetention,
  type Span,
} from "../../lib/otel-tracer";
export { storedZeroDataRetention } from "../../lib/request-context";
export { AGENT_REQUEST_CREDITS_SHARDS } from "../../lib/request-credits-store";
export { requestOrigin } from "../../lib/request-origin";
export {
  SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE,
  getEffectiveSearchForcedKind,
  getSafeMode,
} from "../../lib/safe-mode";
export { calculateThreatScanCredits } from "../../lib/scrape-billing";
export {
  executeCodeViaBrowserSession,
  executePromptViaBrowserAgent,
  getBrowserAgentModel,
  selectBrowserAgentTab,
  type AgentResult,
} from "../../lib/scrape-interact/browser-agent";
export { sanitizeUrlForTrace } from "../../lib/scrape-interact/langsmith";
export {
  buildReplayContextFromScrape,
  buildReplayScript,
  estimateReplayTimeoutSeconds,
} from "../../lib/scrape-interact/scrape-replay";
export {
  hasCategory,
  type CategoryOption,
} from "../../lib/search-query-builder";
export {
  hasHostedMcpProxySecret,
  timingSafeSecretEqual,
} from "../../lib/secret-compare";
export { sendAzureSentinelEvents } from "../../lib/siem-logging/azure-sentinel";
export { emitRejectedScrapeActivityEvents } from "../../lib/siem-logging/index";
export {
  getOrgSiemLoggingConfig,
  upsertOrgSiemLoggingConfig,
} from "../../lib/siem-logging/store";
export {
  SiemDeliveryError,
  siemLoggingConfigInputSchema,
  type OrgSiemLoggingConfig,
  type ScrapeActivityEvent,
} from "../../lib/siem-logging/types";
export { orgIdFromAcuc } from "../../lib/team-org";
export {
  threatProtectionConfigSchema,
  zscalerConfigSchema,
} from "../../lib/threat-protection/config";
export { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
export { zscalerTestConnection } from "../../lib/threat-protection/providers/zscaler/client";
export { consumeZscalerLookupBudget } from "../../lib/threat-protection/providers/zscaler/lookup-queue";
export {
  clearZscalerSyncState,
  consumeZscalerCategoriesBudget,
  getZscalerSyncDocument,
  syncOrgZscalerRules,
  type ZscalerSyncDocument,
} from "../../lib/threat-protection/providers/zscaler/sync";
export {
  THREAT_PROTECTION_CANNOT_TURN_OFF_MESSAGE,
  checkUrlsAgainstThreatPolicy,
  resolveThreatProtection,
} from "../../lib/threat-protection/request";
export {
  ZscalerSecretRequiredError,
  getOrgIdForTeam,
  getOrgThreatProtectionConfig,
  getOrgZscalerCredentials,
  resolveEffectivePolicy,
  upsertOrgThreatProtectionConfig,
  type OrgThreatProtectionConfig,
} from "../../lib/threat-protection/store";
export { getTypeSafeClient } from "../../lib/typesafe";
export { isUsOnly } from "../../lib/us-only";
export {
  isWorldIdConfigured,
  pollWorldIdDeviceFlow,
  startWorldIdDeviceFlow,
  verifyWorldIdCredential,
} from "../../lib/world-id";
export {
  AGENT_ZDR_DEFAULT_RETENTION_MINUTES,
  getAgentZdrRetentionMinutes,
  getScrapeZDR,
  getSearchZDR,
  getThreatProtection,
  isAlexandriaZDRForced,
} from "../../lib/zdr-helpers";

export { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";

export { usesSearchSyntax } from "../../search/operators";

export { exchangeRequest } from "../../services/alexandria/client";
export {
  answerSchema,
  callSchema,
  callsSchema,
  toolSchema,
  toolSummarySchema,
  type DetailedDiscoveredTool,
  type DiscoveredTool,
} from "../../services/alexandria/contracts";
export { capabilityOptionTypes } from "../../services/alexandria/option-types";
export {
  REQUEST_ID_PATTERN,
  exchangeRequestId,
  retrieveProviders,
} from "../../services/alexandria/retrieve";

export {
  CREDITS_FEATURE_ID,
  SEARCH_CREDITS_FEATURE_ID,
  autumnService,
  featureIdForBillingEndpoint,
} from "../../services/autumn/autumn.service";
export {
  TOKENS_PER_CREDIT,
  getTeamBalance,
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
  getTeamHistoricalUsageByEndpoint,
  toTokenPeriods,
  toTokenPeriodsByApiKey,
  type HistoricalBin,
} from "../../services/autumn/usage";
export { billTeam } from "../../services/billing/credit_billing";
export {
  listChannels,
  postToResponseUrl,
} from "../../services/integrations/slack/client";
export {
  handleFirecrawlCommand,
  handleSlashCommand,
} from "../../services/integrations/slack/commands";
export { decryptSlackToken } from "../../services/integrations/slack/crypto";
export {
  createAuthorizeUrl,
  handleOAuthCallback,
  isSlackConfigured,
} from "../../services/integrations/slack/oauth";
export { verifySlackSignature } from "../../services/integrations/slack/signature";
export {
  deleteSlackInstallationByTeam,
  deleteSlackInstallationsBySlackTeam,
  getSlackInstallationBySlackTeam,
  getSlackInstallationByTeam,
} from "../../services/integrations/slack/store";
export type { SlackConnectionStatus } from "../../services/integrations/slack/types";
export {
  logMcpActionLog,
  logProviderScrape,
  logRequest,
  logResearchEndpoint,
  type ResearchRequestKind,
  type ResearchTableName,
} from "../../services/logging/log_job";
export {
  estimateRunsPerMonth,
  validateMonitorCron,
} from "../../services/monitoring/cron";
export {
  confirmRecipientByToken,
  getMonitorNameById,
  listMonitorEmailRecipients,
  unsubscribeRecipientByToken,
} from "../../services/monitoring/email_recipients";
export { syncMonitorEmailRecipients } from "../../services/monitoring/email_recipients_sync";
export {
  getRemovedMonitorTargets,
  trackMonitorConfiguredInterest,
  trackMonitorDeactivatedInterest,
} from "../../services/monitoring/interest";
export {
  MONITOR_ZDR_REFUSED_ERROR,
  enqueueMonitorCheck,
  monitorIsSearch,
  monitorRefusedForZdr,
} from "../../services/monitoring/scheduler";
export {
  countMonitorCheckPages,
  createMonitor,
  createMonitorCheck,
  deleteMonitor,
  estimateMonitorCreditsPerRun,
  getMonitor,
  getMonitorCheck,
  getMonitorForUpdate,
  listMonitorCheckPages,
  listMonitorChecks,
  listMonitors,
  updateMonitor,
} from "../../services/monitoring/store";
export {
  createMonitorSchema,
  listMonitorChecksQuerySchema,
  listMonitorsQuerySchema,
  monitorCheckDetailQuerySchema,
  updateMonitorSchema,
} from "../../services/monitoring/types";
export { notificationsEnv } from "../../services/notification/env";
export { redisRateLimitClient } from "../../services/rate-limiter";
export { WebhookEvent } from "../../services/webhook/index";
export {
  getLatestWebhookLog,
  getLatestWebhookLogsByJob,
  type WebhookLogRow,
} from "../../services/webhook/logs";
export { scrapeQueue } from "../../services/worker/nuq-router";

// Additional shared primitives for policy, hook, and route extensions.
export { getACUCTeam } from "../../controllers/auth";
export {
  getV2RequestSchemas,
  parseBatchScrapeRequest,
  scrapeOptions,
  type MapDocument,
} from "../../controllers/v2/types";
export { indexGetRecent5 } from "../../db/rpc";
export {
  AGENT_INTEROP_HEADER,
  agentInteropStatus,
  isTrustedAgentInteropRequest,
  type AgentInteropStatus,
} from "../../lib/agent-interop";
export {
  crawlToCrawler,
  getCrawl,
  recordThreatBlocked,
  type StoredCrawl,
} from "../../lib/crawl-redis";
export {
  MapFailedError,
  TransportableError,
  UnsupportedSiteError,
  getErrorHttpResponse,
  isTransportableError,
} from "../../lib/error";
export { mapController } from "../../controllers/v2/map";
export {
  ThirdPartyDataTermsRequiredError,
  ThirdPartyDataUnsupportedOptionError,
  canUseExchangeForRequest,
  exchangeClaimsUrl,
  getExchangeAccessForRequest,
  getExchangeRequestLogContext,
  getExchangeResponseLogContext,
  getExchangeSuccessCredits,
  getUnsupportedExchangeFormat,
  isSuccessfulExchangeStatusCode,
  reportExchangeBilling,
  reportExchangeUsageBilling,
  resolveExchangeProvider,
  warmExchangeCatalog,
  type ExchangeAccess,
  type ExchangeScrapeMetadata,
} from "../../lib/exchange";
export { hasFormatOfType } from "../../lib/format-utils";
export { inferIntegration } from "../../lib/infer-integration";
export {
  actionTypesOf,
  checkKeyEndpointRestriction,
  formatTypesOf,
} from "../../lib/key-restriction";
export {
  adjustKeylessCredits,
  consumeKeylessRequest,
  isKeylessConfigured,
  isKeylessTeamId,
  keylessTeamId,
  logKeylessCreditUsage,
  reserveKeylessCredits,
} from "../../lib/keyless";
export { applyMapCollectHook } from "../../lib/map-utils";
export { queryIndex } from "../../lib/map-query-index";
export { checkPermissions, ipWhitelistRefusal } from "../../lib/permissions";
export { jobContext, requestContext } from "../../lib/request-context";
export { sampled } from "../../lib/rollout";
export {
  SAFE_MODE_CREDENTIAL_HEADERS,
  SAFE_MODE_LOGIN_ACTIONS,
  applySafeMode,
  isLockdownZeroDataRetention,
  resolveSafeMode,
  stripCredentialHeaders,
  stripUrlUserinfo,
  type ResolvedSafeMode,
  type SafeModeConfig,
} from "../../lib/safe-mode";
export {
  getSearchIndexClient,
  indexDocumentIfEnabled,
} from "../../lib/search-index-client";
export { searchIndexEnv } from "../../lib/search-index-env";
export {
  emitRejectedScrapeActivityEvent,
  emitScrapeActivityEvent,
} from "../../lib/siem-logging/index";
export { UNSUPPORTED_SITE_MESSAGE } from "../../lib/strings";
export {
  KEYLESS_PLAN_CLASS,
  planClassOf,
  teamPlanClass,
  type TeamPlanClass,
} from "../../lib/team-plan-class";
export { checkUrl } from "../../lib/threat-protection/index";
export { canonicalizeUrl } from "../../lib/threat-protection/providers/web-risk/canonicalize";
export {
  THREAT_PROTECTION_CANNOT_DISABLE_MESSAGE,
  THREAT_PROTECTION_NOT_ENABLED_MESSAGE,
  THREAT_PROTECTION_OVERRIDES_DISABLED_MESSAGE,
  isThreatProtectionForced,
} from "../../lib/threat-protection/request";
export type {
  ThreatDecision,
  ThreatProtectionPolicy,
} from "../../lib/threat-protection/types";
export {
  trackScrape,
  trackSearchRequest,
  trackSearchResults,
} from "../../lib/tracking";
export { US_DATA_REGION, usOnlyLocationRefusal } from "../../lib/us-only";
export { checkAndUpdateURLForMap } from "../../lib/validateUrl";
export {
  getAlexandriaZDR,
  getCustomRobotsAgent,
  getIgnoreRobots,
  getSearchForcedKind,
  isDpaRestricted,
} from "../../lib/zdr-helpers";
export {
  PaywalledContentError,
  SiteRestrictionError,
} from "../../scraper/scrapeURL/error";
export { isPaywalledByJsonLd } from "../../scraper/scrapeURL/lib/accessibleForFree";
export { extractLinks } from "../../scraper/scrapeURL/lib/extractLinks";
export { isMarkdownContentType } from "../../scraper/scrapeURL/lib/extractLinksFromMarkdown";
export { robustFetch } from "../../scraper/scrapeURL/lib/fetch";
export { fireEngineMap } from "../../search/fireEngine";
export {
  firebillConfigured,
  processFirebillTrackRetry,
} from "../../services/autumn/firebill";
export {
  generateDomainSplits,
  generateURLSplits,
  getIndexFromGCS,
  hashURL,
  normalizeURLForIndex,
  queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevel,
  queryIndexAtSplitLevelWithMeta,
  queryOMCESignatures,
  useIndex,
  useSearchIndex,
} from "../../services/index";
export {
  drainZdrRequestLogs,
  logBatchScrape,
  logCrawl,
  logMap,
  logScrape,
  logSearch,
  shutdownPubSubLogging,
} from "../../services/logging/log_job";
export {
  consumeMonitorCheckJobs,
  consumeMonitorSearchCheckJobs,
} from "../../services/monitoring/queue";
export {
  recordMonitorScrapeFailure,
  recordMonitorScrapeSuccess,
} from "../../services/monitoring/results";
export {
  processMonitorCheckJob,
  reconcileRunningMonitorChecks,
} from "../../services/monitoring/runner";
export { enqueueDueMonitorChecks } from "../../services/monitoring/scheduler";
export { sendNotificationWithCustomDays } from "../../services/notification/email_notification";
export {
  createInAppNotification,
  isDashboardOrigin,
} from "../../services/notification/in_app";
export { shouldSendConcurrencyLimitNotification } from "../../services/notification/notification-check";
export { startBullmqQueueMetrics } from "../../services/queue-metrics";
export {
  getFirebillTrackRetryQueue,
  getRedisConnection,
} from "../../services/queue-service";
export { redisEvictConnection } from "../../services/redis";
export { NotificationType, type ScrapeJobData } from "../../types";

export { integrationSchema, resolveIntegration } from "../../utils/integration";
