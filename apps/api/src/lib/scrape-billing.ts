import { InternalOptions } from "../scraper/scrapeURL";
import {
  Document,
  ScrapeOptions,
  TeamFlags,
  shouldParsePDF,
} from "../controllers/v2/types";
import { CostTracking } from "./cost-tracking";
import { hasFormatOfType } from "./format-utils";
import { TransportableError } from "./error";
import { FeatureFlag } from "../scraper/scrapeURL/engines";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { ExchangeScrapeMetadata, getExchangeSuccessCredits } from "./exchange";
import type { ThreatDecision } from "./threat-protection/types";
import { UnsafeDomainBlockedError } from "./threat-protection/error";

const creditsPerPDFPage = 1;
const unblockedDomainCostBonus = 4;
const xTwitterCostBonus = 29;
const jsonCostBonus = 4;
const redactPIICostBonus = 4;
// Each additional PDF page also gets redacted through fire-privacy, so
// the per-page surcharge mirrors the +4 base — same tier as lockdown.
const redactPIIPdfPageCostBonus = 4;
// Threat protection scans: +2 per scanned URL in "normal" mode (Google Web
// Risk). Checks are URL-level and so is the billable unit: consulted
// decisions bill once per unique canonical `decision.url` within one billing
// scope — a scrape and its same-URL re-check share one fee, while a crawl of
// N pages bills N scans (each page job is its own scope). Verdicts are never
// reused across requests (no verdict cache — ZDR). Local-only decisions
// (whitelist/blacklist/blocked-tld, modes off / manual-only, provider
// failure) never bill.
const threatScanCost = 2;

/**
 * Sums the scan fees for a set of threat protection decisions. Only decisions
 * that consulted the provider bill; the fee is +2 per unique scanned
 * canonical URL across the given decisions.
 *
 * "zscaler" mode is exempt: classification runs against the customer's own
 * ZIA tenant (their credentials, their quota), so no scan fee applies.
 */
export function calculateThreatScanCredits(
  decisions: Iterable<ThreatDecision>,
): number {
  const billedUrls = new Set<string>();
  let credits = 0;
  for (const decision of decisions) {
    if (!decision.providerConsulted) continue;
    if (decision.mode === "zscaler") continue;
    // Decisions serialized by a pre-URL-level deploy have no `url`; bill
    // them individually (the old per-decision behavior) rather than letting
    // them all collapse onto one `undefined` key.
    if (decision.url === undefined) {
      credits += threatScanCost;
      continue;
    }
    if (billedUrls.has(decision.url)) continue;
    billedUrls.add(decision.url);
    credits += threatScanCost;
  }
  return credits;
}

/**
 * Whether the prompt injection guard gave this scrape's content a verdict, and
 * so whether its fee bills. The guard writes one cost-tracking record per
 * chunk it attempted and fails open on a chunk it could not classify
 * (verdict "none"): a scan that left any chunk unscanned does not bill. A
 * detection is a verdict for the whole page even if a concurrent chunk failed,
 * since it blocked the extraction.
 */
function promptInjectionGuardGaveVerdict(
  costTrackingJSON: ReturnType<typeof CostTracking.prototype.toJSON>,
): boolean {
  const guardCalls = (costTrackingJSON.calls ?? []).filter(
    call =>
      call.metadata?.module === "scrapeURL" &&
      call.metadata?.method === "checkForPromptInjection",
  );
  if (guardCalls.some(call => call.metadata.verdict === "injection")) {
    return true;
  }
  return (
    guardCalls.length > 0 &&
    guardCalls.every(call => call.metadata.verdict === "clean")
  );
}

export async function calculateCreditsToBeBilled(
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  document: Document | null,
  costTracking: CostTracking | ReturnType<typeof CostTracking.prototype.toJSON>,
  flags: TeamFlags,
  error?: Error | null,
  // Unused by billing today (Enhanced Mode proxies no longer carry a
  // surcharge, so there is nothing to waive when the engine could not honour
  // the feature). Kept because callers pass `exchange` and `threatDecisions`
  // positionally after it.
  _unsupportedFeatures?: Set<FeatureFlag>,
  exchange?: ExchangeScrapeMetadata,
  // Threat protection decisions for this scrape (initial + redirect checks,
  // in order). Each decision with `providerConsulted` bills a scan fee (+2
  // per unique scanned URL) on top of the scrape's own cost — on both success
  // and failure (a scrape blocked by threat protection still consulted the
  // classifier). For scrapes blocked by threat protection, the
  // UnsafeDomainBlockedError in `error` also carries its decision, which is
  // used as a fallback when the decisions array did not make it here.
  threatDecisions?: ThreatDecision[],
) {
  const costTrackingJSON: ReturnType<typeof CostTracking.prototype.toJSON> =
    costTracking instanceof CostTracking ? costTracking.toJSON() : costTracking;

  const effectiveThreatDecisions: ThreatDecision[] =
    threatDecisions && threatDecisions.length > 0
      ? threatDecisions
      : error instanceof UnsafeDomainBlockedError
        ? [error.decision]
        : [];
  const threatScanCredits = calculateThreatScanCredits(
    effectiveThreatDecisions,
  );

  if (document === null) {
    // Failure -- check cost tracking if FIRE-1
    let creditsToBeBilled = 0;

    if (
      internalOptions.v1Agent?.model?.toLowerCase() === "fire-1" ||
      internalOptions.v1JSONAgent?.model?.toLowerCase() === "fire-1"
    ) {
      creditsToBeBilled = Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800);
    }

    if (
      error instanceof TransportableError &&
      error.code === "SCRAPE_LOCKDOWN_CACHE_MISS"
    ) {
      creditsToBeBilled = 1;
    }

    if (
      creditsToBeBilled === 0 &&
      promptInjectionGuardGaveVerdict(costTrackingJSON)
    ) {
      creditsToBeBilled = 5;
    }

    // Failed scrapes bill no base cost (except the cases above), but threat
    // protection scans that already happened still bill — including scrapes
    // blocked by the policy itself.
    return creditsToBeBilled + threatScanCredits;
  }

  const exchangeCredits = getExchangeSuccessCredits({
    exchange,
    statusCode: document.metadata?.statusCode,
  });
  if (exchangeCredits !== null) {
    return exchangeCredits + threatScanCredits;
  }

  let creditsToBeBilled = 1; // Assuming 1 credit per document

  if (options.lockdown) {
    creditsToBeBilled += 4;
  }

  const changeTrackingFormat = hasFormatOfType(
    options.formats,
    "changeTracking",
  );
  if (
    hasFormatOfType(options.formats, "json") ||
    changeTrackingFormat?.modes?.includes("json")
  ) {
    // Additive, so an earlier surcharge such as lockdown survives. A json
    // scrape on its own still totals 5 credits (1 base + 4).
    creditsToBeBilled += jsonCostBonus;
  }

  if (
    hasFormatOfType(options.formats, "json")?.checkPromptInjection &&
    promptInjectionGuardGaveVerdict(costTrackingJSON)
  ) {
    creditsToBeBilled += 4;
  }

  if (hasFormatOfType(options.formats, "deterministicJson")) {
    // 10 when this run generated the extractor script, 3 when it reused a
    // cached one. The codegen call is tagged in deterministicJson/llm/client.ts.
    const generatedScript = costTrackingJSON.calls?.some(
      call =>
        call.metadata?.module === "deterministic-json" &&
        call.metadata?.role === "codegen",
    );
    creditsToBeBilled = generatedScript ? 10 : 3;
  }

  if (
    internalOptions.v1Agent?.model === "fire-1" ||
    internalOptions.v1JSONAgent?.model?.toLowerCase() === "fire-1"
  ) {
    creditsToBeBilled = Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800);
  }

  const hasQuestionFormat =
    hasFormatOfType(options.formats, "question") ||
    hasFormatOfType(options.formats, "query");
  if (hasQuestionFormat) {
    creditsToBeBilled += 4;
  }

  if (hasFormatOfType(options.formats, "highlights")) {
    creditsToBeBilled += 4;
  }

  if (hasFormatOfType(options.formats, "audio")) {
    creditsToBeBilled += 4;
  }

  if (hasFormatOfType(options.formats, "video")) {
    creditsToBeBilled += 4;
  }

  if (document.metadata?.postprocessorsUsed?.includes("x-twitter")) {
    creditsToBeBilled += xTwitterCostBonus;
  }

  if (internalOptions.zeroDataRetention && !options.lockdown) {
    creditsToBeBilled += flags?.zdrCost ?? 1;
  }

  const shouldParse = shouldParsePDF(options.parsers);
  const extraPdfPages =
    shouldParse &&
    document.metadata?.numPages !== undefined &&
    document.metadata.numPages > 1
      ? document.metadata.numPages - 1
      : 0;
  if (extraPdfPages > 0) {
    creditsToBeBilled += creditsPerPDFPage * extraPdfPages;
  }

  if (options.redactPII) {
    // Flat +4 to match lockdown / audio / video — fire-privacy
    // is a peer premium feature, not a cost-based one. PDF pages all
    // pass through redaction too, so each additional page picks up
    // another +4 on top of the +1 page parse cost.
    creditsToBeBilled += redactPIICostBonus;
    if (extraPdfPages > 0) {
      creditsToBeBilled += redactPIIPdfPageCostBonus * extraPdfPages;
    }
  }

  const urlsToCheck = [
    document.metadata?.url,
    document.metadata?.sourceURL,
  ].filter((u): u is string => !!u);
  if (urlsToCheck.some(u => isUrlBlocked(u, null) && !isUrlBlocked(u, flags))) {
    creditsToBeBilled += unblockedDomainCostBonus;
  }

  creditsToBeBilled += threatScanCredits;

  return creditsToBeBilled;
}
