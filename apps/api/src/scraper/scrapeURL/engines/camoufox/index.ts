/**
 * Camoufox stealth fallback.
 *
 * Deliberately narrow: this engine only runs after an ordinary engine came back
 * with anti-bot evidence, at most once per scrape job. Everything else — 404s,
 * DNS/TLS failures, malformed URLs, unsupported downloads, ordinary parse
 * failures — declines immediately with an `EngineError` so the waterfall moves
 * on without paying for a stealth browser.
 *
 * The service speaks the same request/response contract as
 * `apps/playwright-service-ts`, so the result shape needs no special handling
 * downstream.
 */

import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { EngineError } from "../../error";
import { meetsConfidenceThreshold } from "../../lib/antibot";
import { isIPPrivate } from "../utils/safeFetch";
import { camoufoxFallbackCounter } from "../../../../lib/antibot-fallback-metrics";

/**
 * Statuses that a stealth browser can plausibly turn around. 401 is excluded on
 * purpose: it means credentials are required, and no amount of fingerprint
 * shaping fixes that.
 */
const RETRYABLE_BLOCK_STATUSES = [403, 429];

export function isCamoufoxConfigured(): boolean {
  return (
    config.CAMOUFOX_FALLBACK_ENABLED === true &&
    config.CAMOUFOX_SERVICE_URL !== undefined &&
    config.CAMOUFOX_SERVICE_URL !== ""
  );
}

/** Host matches `entry` exactly, or is a subdomain of it. */
function hostMatches(hostname: string, entry: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const target = entry.trim().toLowerCase().replace(/^\.+/, "");
  if (target === "") return false;
  return host === target || host.endsWith(`.${target}`);
}

export function isDomainAllowedForCamoufox(hostname: string): boolean {
  const denylist = config.CAMOUFOX_DOMAIN_DENYLIST ?? [];
  if (denylist.some(entry => hostMatches(hostname, entry))) return false;

  const allowlist = (config.CAMOUFOX_DOMAIN_ALLOWLIST ?? []).filter(
    x => x.trim() !== "",
  );
  if (allowlist.length === 0) return true;
  return allowlist.some(entry => hostMatches(hostname, entry));
}

export async function scrapeURLWithCamoufox(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const state = meta.antibot;
  const url = meta.rewrittenUrl ?? meta.url;

  const decline = (
    outcome: NonNullable<typeof state.camoufoxOutcome>,
    detail: string,
  ): never => {
    state.camoufoxOutcome = outcome;
    state.camoufoxDetail = detail;
    camoufoxFallbackCounter.inc({ outcome });
    throw new EngineError(`Camoufox fallback declined: ${detail}`);
  };

  if (!isCamoufoxConfigured()) {
    decline("skipped_not_applicable", "camoufox fallback is not configured");
  }

  // One stealth attempt per scrape job. `meta.antibot` is a shared mutable
  // holder, so this survives both the per-engine `{...meta}` copies and the
  // outer feature-toggle retry loop that restarts the waterfall.
  if (state.camoufoxAttempts >= 1) {
    decline(
      "skipped_already_attempted",
      "camoufox already attempted once for this job",
    );
  }

  const detection = state.detection;
  if (detection === undefined) {
    decline(
      "skipped_not_applicable",
      "no anti-bot evidence recorded for this job",
    );
  }

  if (!RETRYABLE_BLOCK_STATUSES.includes(detection!.statusCode)) {
    decline(
      "skipped_not_applicable",
      `initial failure status ${detection!.statusCode} is not stealth-retryable`,
    );
  }

  if (!meetsConfidenceThreshold(detection!, config.CAMOUFOX_MIN_CONFIDENCE)) {
    decline(
      "skipped_not_applicable",
      `anti-bot confidence "${detection!.confidence}" below configured minimum "${config.CAMOUFOX_MIN_CONFIDENCE}"`,
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    decline("skipped_not_applicable", "target URL is not parseable");
    throw new Error("unreachable");
  }

  // Defence in depth. The Camoufox service enforces its own SSRF policy, but a
  // literal private address should never even cost us a request: our own SSRF
  // controls surface a blocked target as a 403, which is indistinguishable
  // from an anti-bot 403 by status alone.
  if (isIPPrivate(hostname.replace(/^\[|\]$/g, ""))) {
    decline(
      "skipped_not_applicable",
      "target is a literal private/internal address",
    );
  }

  if (!isDomainAllowedForCamoufox(hostname)) {
    decline("skipped_domain_filter", "host excluded by allowlist/denylist");
  }

  state.camoufoxAttempts += 1;
  camoufoxFallbackCounter.inc({ outcome: "attempt" });
  const startedAt = Date.now();

  meta.logger.info("Invoking Camoufox stealth fallback", {
    host: hostname,
    initialFailureClass: detection!.failureClass,
    confidence: detection!.confidence,
  });

  // The scrape-level budget still wins; the Camoufox timeout only caps how long
  // we are willing to wait on the stealth browser specifically.
  const scrapeTimeout = meta.abort.scrapeTimeout();
  const timeout =
    scrapeTimeout !== undefined
      ? Math.min(scrapeTimeout, config.CAMOUFOX_TIMEOUT_MS)
      : config.CAMOUFOX_TIMEOUT_MS;

  let response: {
    content: string;
    pageStatusCode: number;
    pageError?: string;
    contentType?: string;
  };

  try {
    response = await robustFetch({
      url: config.CAMOUFOX_SERVICE_URL!,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        url,
        wait_after_load: meta.options.waitFor,
        timeout,
        headers: meta.options.headers,
        skip_tls_verification: meta.options.skipTlsVerification,
      },
      method: "POST",
      logger: meta.logger.child("scrapeURLWithCamoufox/robustFetch"),
      schema: z.object({
        content: z.string(),
        pageStatusCode: z.number(),
        pageError: z.string().optional(),
        contentType: z.string().optional(),
      }),
      mock: meta.mock,
      abort: meta.abort.asSignal(),
    });
  } catch (error) {
    state.camoufoxOutcome = "service_unavailable";
    state.camoufoxDetail =
      error instanceof Error ? error.message : String(error);
    state.camoufoxElapsedMs = Date.now() - startedAt;
    camoufoxFallbackCounter.inc({ outcome: "service_unavailable" });
    meta.logger.warn("Camoufox fallback service call failed", {
      host: hostname,
      elapsedMs: state.camoufoxElapsedMs,
      error,
    });
    // Deliberately an EngineError: a stealth service that is down or slow must
    // never take the scrape down with it, it just waterfalls to the next engine.
    throw new EngineError(
      `Camoufox service call failed: ${state.camoufoxDetail}`,
    );
  }

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  state.camoufoxElapsedMs = Date.now() - startedAt;
  const succeeded =
    response.pageStatusCode >= 200 && response.pageStatusCode < 300;
  state.camoufoxOutcome = succeeded ? "success" : "failure";
  camoufoxFallbackCounter.inc({ outcome: succeeded ? "success" : "failure" });

  meta.logger.info("Camoufox stealth fallback completed", {
    host: hostname,
    pageStatusCode: response.pageStatusCode,
    contentLength: response.content.length,
    outcome: state.camoufoxOutcome,
    elapsedMs: state.camoufoxElapsedMs,
  });

  return {
    url,
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,

    proxyUsed: "stealth",
  };
}

export function camoufoxMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + config.CAMOUFOX_TIMEOUT_MS;
}
