/*
 * Unstable internal billing helpers re-exported for custom billing module
 * implementations. Load dynamically so constructing or describing a service
 * does not pull in configuration, queues, or external clients.
 */
import type {} from "../../lib/billing-state";
import type {} from "../../lib/request-context";

export { getACUCTeam } from "../../controllers/auth";
export { CREDIT_CHECK_EXEMPT_TEAM_ID } from "../../controllers/v2/agent-credit-gate";
export { shouldParsePDF } from "../../controllers/v2/types";
export {
  getAgentAuthResourceMetadataUrl,
  shouldEmitAgentAuthDiscoveryHeader,
} from "../../lib/agent-auth-discovery";
export { isAgentInteropSecretValid } from "../../lib/agent-interop";
export {
  getApiKeySpendLimit,
  type ApiKeySpendLimit,
} from "../../lib/api-key-spend-limit";
export { logAuthDenied } from "../../lib/auth-denied-log";
export { CostTracking } from "../../lib/cost-tracking";
export { isTransportableError } from "../../lib/error";
export {
  getExchangeSuccessCredits,
  reportExchangeBilling,
} from "../../lib/exchange";
export { hasFormatOfType } from "../../lib/format-utils";
export {
  adjustKeylessCredits,
  chargeKeylessCredits,
  keylessLimitBody,
  logKeylessCreditUsage,
  reserveKeylessCredits,
} from "../../lib/keyless";
export {
  projectScrapeCredits,
  projectSearchTotalCredits,
} from "../../lib/keyless-credit-projection";
export { getSafeMode } from "../../lib/safe-mode";
export {
  calculateCreditsToBeBilled,
  calculateThreatScanCredits,
} from "../../lib/scrape-billing";
export { orgIdForTeam } from "../../lib/team-org";
export { UnsafeDomainBlockedError } from "../../lib/threat-protection/error";
export type { ThreatDecision } from "../../lib/threat-protection/types";
export { getThreatProtection } from "../../lib/zdr-helpers";
export { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
export { isFreeCatalogueSearch } from "../../search/alexandria";
export { wantsGovCategory } from "../../search/gov";
export {
  autumnService,
  CREDITS_FEATURE_ID,
  featureIdForBillingEndpoint,
  SEARCH_CREDITS_FEATURE_ID,
} from "../autumn/autumn.service";
export {
  checkHostedMcpCredits,
  hostedMcpCreditsRefusal,
} from "../autumn/hosted-mcp-gate";
export { getTeamBalance } from "../autumn/usage";
export { getBillingQueue } from "../queue-service";
export { billTeam } from "./credit_billing";
export {
  resolveBillingMetadata,
  toAutumnBillingProperties,
  type BillingEndpoint,
  type BillingMetadata,
} from "./types";
