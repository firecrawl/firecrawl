import type { RawVerdict, ZscalerPolicySettings } from "../../types";
import { toLookupUrl } from "./client";
import { enqueueZscalerLookup } from "./lookup-queue";

// Zscaler ZIA provider ("zscaler" threat protection mode): inline
// classification via batched POST /urlLookup calls (see ./lookup-queue.ts).
// Custom categories and customer additions never come back from urlLookup —
// those are evaluated locally from the synced rules BEFORE this provider is
// consulted (see ./sync.ts and checkUrlFresh in ../../index.ts).
//
// Verdict normalization into the provider-agnostic contract:
//  - categories = urlClassifications ∪ urlClassificationsWithSecurityAlert;
//    the org's denied-categories selection decides in evaluatePolicy.
//  - securityAlert = the URL carries a security-alert classification.
//  - riskScore stays null: ZIA is categorical, so the score threshold rule
//    never fires for this provider.
//  - raw carries the split lists for server logs only — never for SIEM
//    export (the SIEM event builder reads only the normalized fields).

/**
 * Classify a URL through the org's Zscaler tenant. Throws on quota
 * exhaustion, queue overflow, timeout, and API failures — the caller
 * resolves those through the org's failurePolicy.
 */
export async function fetchZscalerVerdict(
  url: string,
  zscaler: ZscalerPolicySettings,
  options?: { signal?: AbortSignal },
): Promise<RawVerdict> {
  const lookupUrl = toLookupUrl(url);
  const result = await enqueueZscalerLookup(
    zscaler.orgId,
    lookupUrl,
    options?.signal,
  );

  const categories = [
    ...new Set([
      ...result.urlClassifications,
      ...result.urlClassificationsWithSecurityAlert,
    ]),
  ];

  return {
    provider: "zscaler-zia",
    riskScore: null,
    categories,
    securityAlert: result.urlClassificationsWithSecurityAlert.length > 0,
    fromCache: false,
    raw: {
      urlClassifications: result.urlClassifications,
      urlClassificationsWithSecurityAlert:
        result.urlClassificationsWithSecurityAlert,
    },
  };
}
