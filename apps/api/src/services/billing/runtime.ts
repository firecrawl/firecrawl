/*
 * Unstable internal billing helpers exposed through lazy async loaders so
 * importing this entry point never pulls in configuration, queues, or external
 * clients until a custom billing module invokes a loader at runtime.
 */
import type {} from "../../lib/billing-state";
import type {} from "../../lib/request-context";

export type { ApiKeySpendLimit } from "../../lib/api-key-spend-limit";
export type { ThreatDecision } from "../../lib/threat-protection/types";
export type { BillingEndpoint, BillingMetadata } from "./types";

async function importAuthBillingHelpers() {
  const [
    { getACUCTeam },
    { CREDIT_CHECK_EXEMPT_TEAM_ID },
    { getAgentAuthResourceMetadataUrl, shouldEmitAgentAuthDiscoveryHeader },
    { isAgentInteropSecretValid },
    { getApiKeySpendLimit },
    { logAuthDenied },
    { orgIdForTeam },
  ] = await Promise.all([
    import("../../controllers/auth.js"),
    import("../../controllers/v2/agent-credit-gate.js"),
    import("../../lib/agent-auth-discovery.js"),
    import("../../lib/agent-interop.js"),
    import("../../lib/api-key-spend-limit.js"),
    import("../../lib/auth-denied-log.js"),
    import("../../lib/team-org.js"),
  ]);

  return {
    getACUCTeam,
    CREDIT_CHECK_EXEMPT_TEAM_ID,
    getAgentAuthResourceMetadataUrl,
    shouldEmitAgentAuthDiscoveryHeader,
    isAgentInteropSecretValid,
    getApiKeySpendLimit,
    logAuthDenied,
    orgIdForTeam,
  };
}

let authBillingHelpersPromise:
  | ReturnType<typeof importAuthBillingHelpers>
  | undefined;

/** Lazily loads authentication and spend-limit helpers for billing checks. */
export function loadAuthBillingHelpers() {
  return (authBillingHelpersPromise ??= importAuthBillingHelpers());
}

async function importPricingHelpers() {
  const [
    { calculateCreditsToBeBilled, calculateThreatScanCredits },
    { projectScrapeCredits, projectSearchTotalCredits },
    { CostTracking },
    { hasFormatOfType },
    { shouldParsePDF },
    { isFreeCatalogueSearch },
    { wantsGovCategory },
    { getSafeMode },
    { getThreatProtection },
    { isUrlBlocked },
    { isTransportableError },
    { UnsafeDomainBlockedError },
  ] = await Promise.all([
    import("../../lib/scrape-billing.js"),
    import("../../lib/keyless-credit-projection.js"),
    import("../../lib/cost-tracking.js"),
    import("../../lib/format-utils.js"),
    import("../../controllers/v2/types.js"),
    import("../../search/alexandria.js"),
    import("../../search/gov.js"),
    import("../../lib/safe-mode.js"),
    import("../../lib/zdr-helpers.js"),
    import("../../scraper/WebScraper/utils/blocklist.js"),
    import("../../lib/error.js"),
    import("../../lib/threat-protection/error.js"),
  ]);

  return {
    calculateCreditsToBeBilled,
    calculateThreatScanCredits,
    projectScrapeCredits,
    projectSearchTotalCredits,
    CostTracking,
    hasFormatOfType,
    shouldParsePDF,
    isFreeCatalogueSearch,
    wantsGovCategory,
    getSafeMode,
    getThreatProtection,
    isUrlBlocked,
    isTransportableError,
    UnsafeDomainBlockedError,
  };
}

let pricingHelpersPromise: ReturnType<typeof importPricingHelpers> | undefined;

/** Lazily loads credit calculation and request-classification helpers. */
export function loadPricingHelpers() {
  return (pricingHelpersPromise ??= importPricingHelpers());
}

async function importKeylessRuntime() {
  const {
    adjustKeylessCredits,
    chargeKeylessCredits,
    keylessLimitBody,
    logKeylessCreditUsage,
    reserveKeylessCredits,
  } = await import("../../lib/keyless.js");

  return {
    adjustKeylessCredits,
    chargeKeylessCredits,
    keylessLimitBody,
    logKeylessCreditUsage,
    reserveKeylessCredits,
  };
}

let keylessRuntimePromise: ReturnType<typeof importKeylessRuntime> | undefined;

/** Lazily loads keyless reservation and settlement helpers. */
export function loadKeylessRuntime() {
  return (keylessRuntimePromise ??= importKeylessRuntime());
}

async function importBillingRuntime() {
  const [
    {
      autumnService,
      CREDITS_FEATURE_ID,
      featureIdForBillingEndpoint,
      SEARCH_CREDITS_FEATURE_ID,
    },
    { checkHostedMcpCredits, hostedMcpCreditsRefusal },
    { getTeamBalance },
    { getBillingQueue },
    { billTeam },
    { resolveBillingMetadata, toAutumnBillingProperties },
    { getExchangeSuccessCredits, reportExchangeBilling },
  ] = await Promise.all([
    import("../autumn/autumn.service.js"),
    import("../autumn/hosted-mcp-gate.js"),
    import("../autumn/usage.js"),
    import("../queue-service.js"),
    import("./credit_billing.js"),
    import("./types.js"),
    import("../../lib/exchange.js"),
  ]);

  return {
    autumnService,
    CREDITS_FEATURE_ID,
    featureIdForBillingEndpoint,
    SEARCH_CREDITS_FEATURE_ID,
    checkHostedMcpCredits,
    hostedMcpCreditsRefusal,
    getTeamBalance,
    getBillingQueue,
    billTeam,
    resolveBillingMetadata,
    toAutumnBillingProperties,
    getExchangeSuccessCredits,
    reportExchangeBilling,
  };
}

let billingRuntimePromise: ReturnType<typeof importBillingRuntime> | undefined;

/** Lazily loads credit tracking, queue, and usage-balance runtime clients. */
export function loadBillingRuntime() {
  return (billingRuntimePromise ??= importBillingRuntime());
}
