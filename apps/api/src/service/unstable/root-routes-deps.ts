/*
 * Unstable internal bridge for route extensions while shared helper modules
 * remain in this package. Not imported by `./service/index`, so constructing
 * or describing a service never loads these dependencies.
 */
export { getACUCTeam } from "../../controllers/auth";
export type { RequestWithAuth } from "../../controllers/v1/types";
export type { TeamFlags } from "../../controllers/v2/types";
export { alexandriaVerifiedHeader } from "../../lib/alexandria-verified";
export { billingCountryForTeam } from "../../lib/billing-country";
export { clickhouseClient } from "../../lib/clickhouse-client";
export { warmExchangeCatalog } from "../../lib/exchange";
export { notFoundHandler } from "../../lib/not-found";
export { isLockdownZeroDataRetention } from "../../lib/safe-mode";
export { timingSafeSecretEqual } from "../../lib/secret-compare";
export { orgIdFromAcuc } from "../../lib/team-org";
export { isUsOnly } from "../../lib/us-only";
export {
  getSearchForcedKind,
  isAlexandriaZDRForced,
} from "../../lib/zdr-helpers";
export { authMiddleware, wrap } from "../../routes/shared";
export { requestContext } from "../../lib/request-context";
export {
  acceptProviderTerms,
  acceptTermsSchema,
} from "../../services/alexandria/terms";
export {
  autumnService,
  CREDITS_FEATURE_ID,
} from "../../services/autumn/autumn.service";
export { redisRateLimitClient } from "../../services/rate-limiter";
export { RateLimiterMode } from "../../types";
