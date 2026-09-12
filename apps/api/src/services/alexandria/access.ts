import type { TeamFlags } from "../../controllers/v2/types";
import {
  getExchangeProviderAccess,
  getThirdPartyDataTermsRequiredResponse,
} from "../../lib/exchange";
import { refusal, type ExchangeResponse, type ProviderCall } from "./contracts";

/**
 * The same catalog terms and organization access flags the URL-routed
 * Exchange scrape path checks, applied to the providers a request names.
 * Returns the refusal to send, or undefined when every provider may run.
 */
export async function authorizeProviders(
  calls: ProviderCall[],
  flags: TeamFlags | null | undefined,
): Promise<ExchangeResponse | undefined> {
  for (const provider of new Set(calls.map(call => call.provider))) {
    const access = await getExchangeProviderAccess(provider, flags);
    if (access.decision === "unavailable")
      return refusal(
        503,
        "Provider catalog is unavailable. No provider was executed.",
      );
    if (access.decision === "not_enabled")
      return refusal(
        403,
        `Access to ${provider} is disabled for this organization.`,
      );
    if (access.decision === "terms_required")
      return {
        status: 403,
        body: getThirdPartyDataTermsRequiredResponse(access.terms),
      };
  }
  return undefined;
}
