/**
 * FlareSolverr challenge-solver fallback.
 *
 * Last resort in the waterfall, and deliberately narrower than Camoufox: it
 * only runs after an ordinary engine produced a *confirmed* challenge
 * fingerprint, at most once per scrape job. Everything else declines
 * immediately with an `EngineError` so the waterfall moves on.
 *
 * Why it exists alongside Camoufox: measured on the validation corpus,
 * FlareSolverr cleared researchgate.net (DataDome, 551 KB of real article
 * content, 45s) which Camoufox could not. It does NOT clear the interactive
 * Cloudflare Turnstile on academic.oup.com or sciencedirect.com -- those burn
 * the full timeout and fail, which is why this engine sits last and is capped.
 *
 * The one thing this module must not do is trust FlareSolverr's own verdict.
 * FlareSolverr only fingerprints Cloudflare, so it reports
 * `"Challenge not detected!"` with HTTP 200 while handing back an AWS WAF
 * interstitial (observed: ieeexplore, 2 KB) or a PerimeterX/reCAPTCHA one
 * (observed: jstor, 7.5 KB). Returning those verbatim would reintroduce exactly
 * the "challenge page marked successful" bug this engine is meant to help fix,
 * so every response is re-classified locally before it is accepted.
 */

import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { EngineError } from "../../error";
import {
  classifyAntibotResponse,
  meetsConfidenceThreshold,
} from "../../lib/antibot";
import { isIPPrivate } from "../utils/safeFetch";
import { flaresolverrFallbackCounter } from "../../../../lib/antibot-fallback-metrics";
import axios from "axios";

/**
 * Statuses worth handing to a challenge solver. Unlike Camoufox (403/429 only)
 * this admits the whole 2xx range, because the interstitial-under-a-success is
 * the case it exists for: PMC serves its reCAPTCHA as 200 and ieeexplore serves
 * its AWS WAF challenge as *202*, so an exact `=== 200` check would miss it.
 * 401 stays out -- credentials are not a challenge.
 */
function isSolverRetryableStatus(statusCode: number): boolean {
  if (statusCode >= 200 && statusCode < 300) return true;
  return statusCode === 403 || statusCode === 429;
}

export function isFlaresolverrConfigured(): boolean {
  return (
    config.FLARESOLVERR_ENABLED === true &&
    config.FLARESOLVERR_URL !== undefined &&
    config.FLARESOLVERR_URL !== ""
  );
}

/** Host matches `entry` exactly, or is a subdomain of it. */
function hostMatches(hostname: string, entry: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const target = entry.trim().toLowerCase().replace(/^\.+/, "");
  if (target === "") return false;
  return host === target || host.endsWith(`.${target}`);
}

export function isDomainAllowedForFlaresolverr(hostname: string): boolean {
  const denylist = config.FLARESOLVERR_DOMAIN_DENYLIST ?? [];
  if (denylist.some(entry => hostMatches(hostname, entry))) return false;

  const allowlist = (config.FLARESOLVERR_DOMAIN_ALLOWLIST ?? []).filter(
    x => x.trim() !== "",
  );
  if (allowlist.length === 0) return true;
  return allowlist.some(entry => hostMatches(hostname, entry));
}

const flaresolverrResponseSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  solution: z
    .object({
      url: z.string().optional(),
      status: z.number().optional(),
      response: z.string().optional(),
      userAgent: z.string().optional(),
    })
    .optional(),
});

let healthCache:
  | { checkedAt: number; healthy: boolean; detail?: string }
  | undefined;

async function checkFlaresolverrHealth(): Promise<{
  healthy: boolean;
  detail?: string;
}> {
  if (healthCache && Date.now() - healthCache.checkedAt < 30_000) {
    return healthCache;
  }
  try {
    const healthUrl = new URL("/health", config.FLARESOLVERR_URL!).toString();
    await axios.get(healthUrl, { timeout: 2_000 });
    healthCache = { checkedAt: Date.now(), healthy: true };
  } catch (error) {
    healthCache = {
      checkedAt: Date.now(),
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return healthCache;
}

export async function scrapeURLWithFlaresolverr(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const state = meta.antibot;
  const url = meta.rewrittenUrl ?? meta.url;

  const decline = (
    outcome: NonNullable<typeof state.flaresolverrOutcome>,
    detail: string,
  ): never => {
    state.flaresolverrOutcome = outcome;
    state.flaresolverrDetail = detail;
    flaresolverrFallbackCounter.inc({ outcome });
    throw new EngineError(`FlareSolverr fallback declined: ${detail}`);
  };

  if (!isFlaresolverrConfigured()) {
    decline(
      "skipped_not_applicable",
      "flaresolverr fallback is not configured",
    );
  }

  // One solve attempt per scrape job. `meta.antibot` is a shared mutable holder,
  // so this survives the per-engine `{...meta}` copies and the outer
  // feature-toggle retry loop that restarts the waterfall.
  if (state.flaresolverrAttempts >= 1) {
    decline(
      "skipped_already_attempted",
      "flaresolverr already attempted once for this job",
    );
  }

  const detection = state.detection;
  if (detection === undefined) {
    decline(
      "skipped_not_applicable",
      "no anti-bot evidence recorded for this job",
    );
  }

  if (!isSolverRetryableStatus(detection!.statusCode)) {
    decline(
      "skipped_not_applicable",
      `initial failure status ${detection!.statusCode} is not solver-retryable`,
    );
  }

  if (
    !meetsConfidenceThreshold(detection!, config.FLARESOLVERR_MIN_CONFIDENCE)
  ) {
    decline(
      "skipped_not_applicable",
      `anti-bot confidence "${detection!.confidence}" below configured minimum "${config.FLARESOLVERR_MIN_CONFIDENCE}"`,
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    decline("skipped_not_applicable", "target URL is not parseable");
    throw new Error("unreachable");
  }

  // Defence in depth. FlareSolverr has no SSRF policy of its own -- it will
  // happily drive its browser at anything -- so a literal private address must
  // be refused here, before it costs a request.
  if (isIPPrivate(hostname.replace(/^\[|\]$/g, ""))) {
    decline(
      "skipped_not_applicable",
      "target is a literal private/internal address",
    );
  }

  if (!isDomainAllowedForFlaresolverr(hostname)) {
    decline("skipped_domain_filter", "host excluded by allowlist/denylist");
  }

  const health = await checkFlaresolverrHealth();
  if (!health.healthy) {
    decline(
      "service_unavailable",
      `flaresolverr health check failed: ${health.detail ?? "unknown error"}`,
    );
  }

  state.flaresolverrAttempts += 1;
  flaresolverrFallbackCounter.inc({ outcome: "attempt" });
  const startedAt = Date.now();

  meta.logger.info("Invoking FlareSolverr challenge fallback", {
    host: hostname,
    initialFailureClass: detection!.failureClass,
    confidence: detection!.confidence,
  });

  // The scrape-level budget still wins; the FlareSolverr timeout only caps how
  // long we wait on the solver specifically.
  const scrapeTimeout = meta.abort.scrapeTimeout();
  const timeout =
    scrapeTimeout !== undefined
      ? Math.min(scrapeTimeout, config.FLARESOLVERR_TIMEOUT_MS)
      : config.FLARESOLVERR_TIMEOUT_MS;

  let response: z.infer<typeof flaresolverrResponseSchema>;
  try {
    response = await robustFetch({
      url: config.FLARESOLVERR_URL!,
      headers: { "Content-Type": "application/json" },
      body: {
        cmd: "request.get",
        url,
        maxTimeout: timeout,
      },
      method: "POST",
      logger: meta.logger.child("scrapeURLWithFlaresolverr/robustFetch"),
      schema: flaresolverrResponseSchema,
      mock: meta.mock,
      abort: meta.abort.asSignal(),
    });
  } catch (error) {
    state.flaresolverrOutcome = "service_unavailable";
    state.flaresolverrDetail =
      error instanceof Error ? error.message : String(error);
    state.flaresolverrElapsedMs = Date.now() - startedAt;
    flaresolverrFallbackCounter.inc({ outcome: "service_unavailable" });
    meta.logger.warn("FlareSolverr fallback service call failed", {
      host: hostname,
      elapsedMs: state.flaresolverrElapsedMs,
      error,
    });
    // Deliberately an EngineError: a solver that is down, slow, or that failed
    // to clear the challenge (FlareSolverr answers HTTP 500 for that) must never
    // take the scrape down with it.
    throw new EngineError(
      `FlareSolverr service call failed: ${state.flaresolverrDetail}`,
    );
  }

  state.flaresolverrElapsedMs = Date.now() - startedAt;
  const html = response.solution?.response ?? "";
  const pageStatusCode = response.solution?.status ?? 0;

  if (response.status !== "ok" || html === "") {
    state.flaresolverrOutcome = "failure";
    state.flaresolverrDetail = response.message ?? "solver returned no content";
    flaresolverrFallbackCounter.inc({ outcome: "failure" });
    throw new EngineError(
      `FlareSolverr did not return a solution: ${state.flaresolverrDetail}`,
    );
  }

  if (html.length > config.FLARESOLVERR_MAX_RESPONSE_BYTES) {
    state.flaresolverrOutcome = "failure";
    state.flaresolverrDetail = `response ${html.length} bytes exceeds cap`;
    flaresolverrFallbackCounter.inc({ outcome: "failure" });
    throw new EngineError(
      `FlareSolverr response too large: ${state.flaresolverrDetail}`,
    );
  }

  // The load-bearing check. FlareSolverr's own "Challenge not detected!" is only
  // a Cloudflare verdict, so a cleanly-reported 200 can still be an AWS WAF or
  // PerimeterX interstitial. Re-classify locally and refuse to pass one on.
  const postCheck = classifyAntibotResponse({
    statusCode: pageStatusCode,
    html,
  });
  if (postCheck.confidence === "confirmed") {
    state.flaresolverrOutcome = "challenge_not_cleared";
    state.flaresolverrDetail = postCheck.failureClass;
    flaresolverrFallbackCounter.inc({ outcome: "challenge_not_cleared" });
    meta.logger.warn(
      "FlareSolverr reported success but returned a challenge page",
      {
        host: hostname,
        solverMessage: response.message,
        failureClass: postCheck.failureClass,
        vendor: postCheck.vendor,
        contentLength: html.length,
        elapsedMs: state.flaresolverrElapsedMs,
      },
    );
    throw new EngineError(
      `FlareSolverr returned an unsolved challenge: ${postCheck.failureClass}`,
    );
  }

  state.flaresolverrOutcome = "success";
  flaresolverrFallbackCounter.inc({ outcome: "success" });
  meta.logger.info("FlareSolverr challenge fallback completed", {
    host: hostname,
    pageStatusCode,
    contentLength: html.length,
    solverMessage: response.message,
    elapsedMs: state.flaresolverrElapsedMs,
  });

  return {
    url: response.solution?.url ?? url,
    html,
    statusCode: pageStatusCode,
    contentType: "text/html",

    proxyUsed: "stealth",
  };
}

export function flaresolverrMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + config.FLARESOLVERR_TIMEOUT_MS;
}
