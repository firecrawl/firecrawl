/*
 * Unstable internal bridge exporting route middleware and shared helper
 * primitives for v2 route extensions while those helpers still live in this
 * package. Not imported by `./service/index`, so constructing or describing
 * a service never loads these dependencies.
 */

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
export {
  agentRequestSchema,
  countryLocationSchema,
  endpointFeedbackSchema,
  searchFeedbackSchema,
} from "../../controllers/v2/types";
export type {
  AgentCancelResponse,
  AgentExchangeSummary,
  AgentListResponse,
  AgentMode,
  AgentPendingApproval,
  AgentRequest,
  AgentResponse,
  AgentSkillResponse,
  AgentSnapshotResponse,
  AgentStatusResponse,
  AgentSuggestion,
  AgentThread,
  AgentThreadResponse,
  AgentTraceResponse,
  EndpointFeedbackEndpoint,
  EndpointFeedbackErrorCode,
  EndpointFeedbackRequest,
  EndpointFeedbackResponse,
  ErrorResponse,
  RequestWithAuth,
  ScrapeOptions,
  SearchFeedbackErrorCode,
  SearchFeedbackRequest,
  SearchFeedbackResponse,
} from "../../controllers/v2/types";

export { agentConsumeFreeRequestIfLeft } from "../../db/rpc";

export { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
export { isAgentInteropSecretValid } from "../../lib/agent-interop";
export { ZDR_EXPIRED_ERROR, agentJobExpiry } from "../../lib/agent-job-expiry";
export {
  getRecentAlexandriaCalls,
  hasRecentAlexandriaActivity,
  type AlexandriaCall,
} from "../../lib/alexandria-activity";
export { alexandriaFeedbackStorage } from "../../lib/alexandria-feedback-storage";
export {
  MAX_FEEDBACK_TOKEN_LENGTH,
  checkFeedbackToken,
  type FeedbackTokenRejection,
} from "../../lib/alexandria-feedback-token";
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
export type { SearchResultType } from "../../lib/entities";
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
export { feedbackTrace, type FeedbackTrace } from "../../lib/feedback-trace";
export { getMonitorDiffArtifact } from "../../lib/gcs-monitoring";
export {
  HangarError,
  deleteHangarProfile,
  executeHangarBrowser,
  getHangarBrowser,
  getHangarRecording,
  type BrowserExecutionResult,
} from "../../lib/hangar";
export { readScrapeJobState } from "../../lib/job-state-store";
export {
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  checkKeylessEligibility,
  isKeylessIpEligible,
  keylessLimitBody,
  keylessLimitPromptForTeam,
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
export {
  SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE,
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
export { timingSafeSecretEqual } from "../../lib/secret-compare";
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
} from "../../lib/zdr-helpers";

export { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";

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
export { logRequest } from "../../services/logging/log_job";
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

export { integrationSchema } from "../../utils/integration";
