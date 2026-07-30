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
import {
  CreditLine,
  sumCreditLines,
  isDocumentContentType,
  applyDocumentTag,
} from "./credit-lines";
import {
  CREDITS_FEATURE_ID,
  JSON_CREDITS_FEATURE_ID,
} from "../services/autumn/autumn.service";

const creditsPerPDFPage = 1;
const stealthProxyCostBonus = 4;
const unblockedDomainCostBonus = 4;
const xTwitterCostBonus = 29;
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
// (whitelist/blacklist/blocked-tld, mode off, provider failure) never bill.
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

export async function calculateCreditsToBeBilled(
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  document: Document | null,
  costTracking: CostTracking | ReturnType<typeof CostTracking.prototype.toJSON>,
  flags: TeamFlags,
  error?: Error | null,
  unsupportedFeatures?: Set<FeatureFlag>,
  exchange?: ExchangeScrapeMetadata,
  threatDecisions?: ThreatDecision[],
): Promise<number> {
  return sumCreditLines(
    await calculateCreditLines(
      options,
      internalOptions,
      document,
      costTracking,
      flags,
      error,
      unsupportedFeatures,
      exchange,
      threatDecisions,
    ),
  );
}

/**
 * Computes a scrape's charge as a list of tagged {@link CreditLine}s — the
 * per-feature breakdown behind {@link calculateCreditsToBeBilled}, whose scalar
 * total is exactly `sumCreditLines(...)` of this.
 *
 * Each surcharge is tagged with the Autumn feature it meters against: the base
 * scrape and most premiums against CREDITS, the JSON-output premium against
 * JSON_CREDITS, and — when the scrape resolved to a document — the whole
 * CREDITS portion is re-tagged onto DOCUMENT_CREDITS (format premiums such as
 * JSON keep their own pool). The ledger total is unaffected by tagging; only
 * which Autumn feature each portion debits changes.
 *
 * Override-style premiums (json, deterministicJson, fire-1) replace the charge
 * accrued so far and then let subsequent additive premiums apply, mirroring the
 * previous scalar semantics exactly (including that json wipes a preceding
 * lockdown surcharge).
 */
export async function calculateCreditLines(
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  document: Document | null,
  costTracking: CostTracking | ReturnType<typeof CostTracking.prototype.toJSON>,
  flags: TeamFlags,
  error?: Error | null,
  unsupportedFeatures?: Set<FeatureFlag>,
  exchange?: ExchangeScrapeMetadata,
  // Threat protection decisions for this scrape (initial + redirect checks,
  // in order). Each decision with `providerConsulted` bills a scan fee (+2
  // per unique scanned URL) on top of the scrape's own cost — on both success
  // and failure (a scrape blocked by threat protection still consulted the
  // classifier). For scrapes blocked by threat protection, the
  // UnsafeDomainBlockedError in `error` also carries its decision, which is
  // used as a fallback when the decisions array did not make it here.
  threatDecisions?: ThreatDecision[],
): Promise<CreditLine[]> {
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
  // Threat scans meter against general credits (re-tagged to DOCUMENT_CREDITS
  // below when the scrape is a document, like the rest of the base charge).
  const threatLines: CreditLine[] =
    threatScanCredits > 0
      ? [
          {
            feature: CREDITS_FEATURE_ID,
            credits: threatScanCredits,
            reason: "threat-scan",
          },
        ]
      : [];

  if (document === null) {
    // Failure -- check cost tracking if FIRE-1
    let failureBase = 0;

    if (
      internalOptions.v1Agent?.model?.toLowerCase() === "fire-1" ||
      internalOptions.v1JSONAgent?.model?.toLowerCase() === "fire-1"
    ) {
      failureBase = Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800);
    }

    // Bill for DNS resolution errors
    if (
      error instanceof TransportableError &&
      (error.code === "SCRAPE_DNS_RESOLUTION_ERROR" ||
        error.code === "SCRAPE_LOCKDOWN_CACHE_MISS")
    ) {
      failureBase = 1;
    }

    // Failed scrapes bill no base cost (except the cases above), but threat
    // protection scans that already happened still bill — including scrapes
    // blocked by the policy itself.
    const failureLines: CreditLine[] =
      failureBase > 0
        ? [
            {
              feature: CREDITS_FEATURE_ID,
              credits: failureBase,
              reason: "failure-base",
            },
          ]
        : [];
    return [...failureLines, ...threatLines];
  }

  const exchangeCredits = getExchangeSuccessCredits({
    exchange,
    statusCode: document.metadata?.statusCode,
  });
  if (exchangeCredits !== null) {
    return [
      {
        feature: CREDITS_FEATURE_ID,
        credits: exchangeCredits,
        reason: "exchange",
      },
      ...threatLines,
    ];
  }

  let lines: CreditLine[] = [
    { feature: CREDITS_FEATURE_ID, credits: 1, reason: "base" },
  ];

  if (options.lockdown) {
    lines.push({ feature: CREDITS_FEATURE_ID, credits: 4, reason: "lockdown" });
  }

  const changeTrackingFormat = hasFormatOfType(
    options.formats,
    "changeTracking",
  );
  if (
    hasFormatOfType(options.formats, "json") ||
    changeTrackingFormat?.modes?.includes("json")
  ) {
    // Total 5, split so the JSON-output premium meters against JSON_CREDITS
    // while the base scrape stays on general credits. Replaces prior lines,
    // matching the old `= 5` override (which wiped a preceding lockdown).
    lines = [
      { feature: CREDITS_FEATURE_ID, credits: 1, reason: "base" },
      { feature: JSON_CREDITS_FEATURE_ID, credits: 4, reason: "json" },
    ];
  }

  if (hasFormatOfType(options.formats, "deterministicJson")) {
    // 10 when this run generated the extractor script, 3 when it reused a
    // cached one. The codegen call is tagged in deterministicJson/llm/client.ts.
    const generatedScript = costTrackingJSON.calls?.some(
      call =>
        call.metadata?.module === "deterministic-json" &&
        call.metadata?.role === "codegen",
    );
    lines = [
      {
        feature: CREDITS_FEATURE_ID,
        credits: generatedScript ? 10 : 3,
        reason: "deterministic-json",
      },
    ];
  }

  if (
    internalOptions.v1Agent?.model === "fire-1" ||
    internalOptions.v1JSONAgent?.model?.toLowerCase() === "fire-1"
  ) {
    lines = [
      {
        feature: CREDITS_FEATURE_ID,
        credits: Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800),
        reason: "fire-1",
      },
    ];
  }

  const hasQuestionFormat =
    hasFormatOfType(options.formats, "question") ||
    hasFormatOfType(options.formats, "query");
  if (hasQuestionFormat) {
    lines.push({ feature: CREDITS_FEATURE_ID, credits: 4, reason: "question" });
  }

  if (hasFormatOfType(options.formats, "highlights")) {
    lines.push({
      feature: CREDITS_FEATURE_ID,
      credits: 4,
      reason: "highlights",
    });
  }

  if (hasFormatOfType(options.formats, "audio")) {
    lines.push({ feature: CREDITS_FEATURE_ID, credits: 4, reason: "audio" });
  }

  if (hasFormatOfType(options.formats, "video")) {
    lines.push({ feature: CREDITS_FEATURE_ID, credits: 4, reason: "video" });
  }

  if (document.metadata?.postprocessorsUsed?.includes("x-twitter")) {
    lines.push({
      feature: CREDITS_FEATURE_ID,
      credits: xTwitterCostBonus,
      reason: "x-twitter",
    });
  }

  if (internalOptions.zeroDataRetention && !options.lockdown) {
    lines.push({
      feature: CREDITS_FEATURE_ID,
      credits: flags?.zdrCost ?? 1,
      reason: "zdr",
    });
  }

  const shouldParse = shouldParsePDF(options.parsers);
  const extraPdfPages =
    shouldParse &&
    document.metadata?.numPages !== undefined &&
    document.metadata.numPages > 1
      ? document.metadata.numPages - 1
      : 0;
  if (extraPdfPages > 0) {
    lines.push({
      feature: CREDITS_FEATURE_ID,
      credits: creditsPerPDFPage * extraPdfPages,
      reason: "pdf-pages",
    });
  }

  if (options.redactPII) {
    // Flat +4 to match lockdown / audio / video / stealth — fire-privacy
    // is a peer premium feature, not a cost-based one. PDF pages all
    // pass through redaction too, so each additional page picks up
    // another +4 on top of the +1 page parse cost.
    lines.push({
      feature: CREDITS_FEATURE_ID,
      credits: redactPIICostBonus,
      reason: "redact-pii",
    });
    if (extraPdfPages > 0) {
      lines.push({
        feature: CREDITS_FEATURE_ID,
        credits: redactPIIPdfPageCostBonus * extraPdfPages,
        reason: "redact-pii-pdf-pages",
      });
    }
  }

  if (
    document?.metadata?.proxyUsed === "stealth" &&
    !unsupportedFeatures?.has("stealthProxy") // if stealth proxy was unsupported, don't bill for it
  ) {
    lines.push({
      feature: CREDITS_FEATURE_ID,
      credits: stealthProxyCostBonus,
      reason: "stealth-proxy",
    });
  }

  const urlsToCheck = [
    document.metadata?.url,
    document.metadata?.sourceURL,
  ].filter((u): u is string => !!u);
  if (urlsToCheck.some(u => isUrlBlocked(u, null) && !isUrlBlocked(u, flags))) {
    lines.push({
      feature: CREDITS_FEATURE_ID,
      credits: unblockedDomainCostBonus,
      reason: "unblocked-domain",
    });
  }

  lines.push(...threatLines);

  // A document scrape meters its whole general-credit charge (base + premiums
  // tagged CREDITS) against DOCUMENT_CREDITS. Format pools like JSON_CREDITS
  // keep their tag, so a JSON extraction over a PDF splits across both.
  if (isDocumentContentType(document.metadata?.contentType)) {
    lines = applyDocumentTag(lines);
  }

  return lines;
}
