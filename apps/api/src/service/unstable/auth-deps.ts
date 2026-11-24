/*
 * Unstable internal bridge for custom AuthModule implementations while shared
 * helper modules still live in this package. Not imported by `./service/index`,
 * so constructing or describing a service never loads these dependencies.
 */
export {
  getACUC,
  keylessClientIp,
  mockPreviewACUC,
} from "../../controllers/auth";
export type {
  AuthCreditUsageChunk,
  TeamFlags,
} from "../../controllers/v1/types";
export { db, dbRr } from "../../db/connection";
export {
  agent_sponsors,
  api_keys,
  vercel_marketplace_resources,
} from "../../db/schema";
export {
  getAgentAuthResourceMetadataUrl,
  shouldEmitAgentAuthDiscoveryHeader,
} from "../../lib/agent-auth-discovery";
export { isTrustedAgentInteropRequest } from "../../lib/agent-interop";
export {
  logAuthDenied,
  type AuthDenialReason,
} from "../../lib/auth-denied-log";
export { consumeIndexRateLimit } from "../../lib/index-daily-limit";
export { checkIpRestriction } from "../../lib/ip-restriction";
export { checkKeyEndpointRestriction } from "../../lib/key-restriction";
export {
  consumeKeylessRequest,
  isKeylessConfigured,
  isKeylessIpEligible,
  keylessExhaustionTelemetry,
  keylessLimitPrompt,
  keylessSignupUrlForIp,
  keylessTeamId,
  keylessWorldIdIdentity,
  normalizeKeylessIpv4,
  reportKeylessPromptShown,
} from "../../lib/keyless";
export { keylessAuthTotal } from "../../lib/keyless-metrics";
export { keylessSignupSurface } from "../../lib/keyless-signup-link";
export { isValidUuid } from "../../lib/owner-id";
export { parseApi } from "../../lib/parseApi";
export {
  hasHostedMcpProxySecret,
  timingSafeSecretEqual,
} from "../../lib/secret-compare";
export { isKeylessIpSuspicious } from "../../lib/spur";
export { KEYLESS_PLAN_CLASS } from "../../lib/team-plan-class";
export { verifyWorldIdCredential } from "../../lib/world-id";
export {
  getAutumnRateLimiter,
  getHostedMcpConcurrencyLimit,
  getHostedMcpRateLimiter,
  getRateLimiter,
  getRateLimitOverride,
  HOBBY_RATE_LIMIT_MULTIPLIER,
} from "../../services/rate-limiter";
export { getValue, setValue } from "../../services/redis";
export { RateLimiterMode } from "../../types";
export { resolveIntegration } from "../../utils/integration";
