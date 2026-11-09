import { createHash } from "node:crypto";
import type { Meta } from "../../..";
import {
  firePdfRouteDecisionsTotal,
  firePdfRouteRemainingSeconds,
} from "./metrics";
import type { FirePdfSourceKind } from "./request-metadata";
import { MIN_ASYNC_CALLER_WINDOW_MS } from "./schema";

export const FIRE_PDF_ASYNC_MIN_REMAINING_MS = MIN_ASYNC_CALLER_WINDOW_MS;

type FirePdfAsyncRouteReason =
  | "zdr"
  | "deadline_too_close"
  | "team_disabled"
  | "team_forced"
  | "request_override"
  | "bulk_origin"
  | "percentage"
  | "percentage_disabled"
  | "outside_percentage";

type FirePdfAsyncRouteDecision = {
  enabled: boolean;
  reason: FirePdfAsyncRouteReason;
};

type FirePdfAsyncRouteInput = {
  scrapeId: string;
  teamId?: string;
  zeroDataRetention: boolean;
  remainingMs?: number;
  requestOptIn: boolean;
  percentage: number;
  forceTeamIds?: string;
  disableTeamIds?: string;
  allowRequestOverride: boolean;
  /** Scrape is a child of a crawl or batch scrape (carries a crawlId).
   * No caller is blocked on this specific document, so it can ride the
   * async lane under its own, separately ramped percentage. */
  bulkOrigin?: boolean;
  bulkOriginPercentage?: number;
};

function parseTeamIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean),
  );
}

export function deterministicPercentage(key: string): number {
  const prefix = createHash("sha256").update(key).digest().readUInt32BE(0);
  return (prefix / 2 ** 32) * 100;
}

export function decideFirePdfAsyncRoute(
  input: FirePdfAsyncRouteInput,
): FirePdfAsyncRouteDecision {
  if (input.zeroDataRetention) return { enabled: false, reason: "zdr" };
  if (
    input.remainingMs !== undefined &&
    input.remainingMs < FIRE_PDF_ASYNC_MIN_REMAINING_MS
  ) {
    return { enabled: false, reason: "deadline_too_close" };
  }

  const disabledTeams = parseTeamIds(input.disableTeamIds);
  if (input.teamId && disabledTeams.has(input.teamId)) {
    return { enabled: false, reason: "team_disabled" };
  }

  const forcedTeams = parseTeamIds(input.forceTeamIds);
  if (input.teamId && forcedTeams.has(input.teamId)) {
    return { enabled: true, reason: "team_forced" };
  }

  if (input.requestOptIn && input.allowRequestOverride) {
    return { enabled: true, reason: "request_override" };
  }

  // Crawl/batch children ramp on their own cohort. The hash is keyed
  // separately from the general cohort so the two percentages stay
  // independent; a bulk scrape outside its cohort still falls through
  // to the general percentage below.
  if (
    input.bulkOrigin &&
    (input.bulkOriginPercentage ?? 0) > 0 &&
    deterministicPercentage(`bulk-origin:${input.scrapeId}`) <
      (input.bulkOriginPercentage ?? 0)
  ) {
    return { enabled: true, reason: "bulk_origin" };
  }

  if (input.percentage <= 0) {
    return { enabled: false, reason: "percentage_disabled" };
  }
  if (deterministicPercentage(input.scrapeId) < input.percentage) {
    return { enabled: true, reason: "percentage" };
  }
  return { enabled: false, reason: "outside_percentage" };
}

/** Why a request's first FirePDF attempt took the transport it did: the
 * async cohort decision for inline PDFs, plus the two routes that never
 * consult it (large PDFs always go by reference; images have no async
 * route yet). */
type FirePdfRouteReason =
  | FirePdfAsyncRouteReason
  | "by_reference"
  | "no_async_route";

type FirePdfRoute = {
  sourceKind: FirePdfSourceKind;
  path: "sync" | "async";
  reason: FirePdfRouteReason;
  features: string;
  /** Caller time left when the transport was chosen. Pass it when the
   * decision is recorded after the attempt ran; defaults to now. */
  remainingMs?: number;
};

/** Stable label for the page-aware options a request asked for, e.g.
 * "none" or "pages+markers". At most 8 values. */
export function firePdfFeaturesLabel(features: {
  pageMarkdown: boolean;
  blocks: boolean;
  pageMarkers: boolean;
}): string {
  const parts = [
    features.pageMarkdown && "pages",
    features.blocks && "blocks",
    features.pageMarkers && "markers",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("+") : "none";
}

/**
 * Counts every first-attempt transport decision, sync and async alike, so
 * the sync remainder can be attributed (ZDR, short deadline, outside the
 * cohort, images) without reconstructing it from logs. Labels only: no URL
 * or content, so it is safe for ZDR requests. Async decisions are already
 * logged by the caller (`fire_pdf_async_routed`); sync ones are logged here.
 */
export function recordFirePdfRoute(meta: Meta, route: FirePdfRoute): void {
  const zdr = meta.internalOptions.zeroDataRetention ?? false;
  firePdfRouteDecisionsTotal
    .labels(
      route.sourceKind,
      route.path,
      route.reason,
      route.features,
      String(zdr),
    )
    .inc();

  const remainingMs =
    "remainingMs" in route ? route.remainingMs : meta.abort.scrapeTimeout();
  if (remainingMs !== undefined) {
    firePdfRouteRemainingSeconds
      .labels(route.sourceKind, route.path)
      .observe(Math.max(0, remainingMs) / 1000);
  }

  if (route.path === "sync") {
    meta.logger.info("Routing FirePDF request to sync /ocr", {
      method: route.sourceKind === "image" ? "scrapeImage" : "scrapePDF",
      event: "fire_pdf_sync_routed",
      source_kind: route.sourceKind,
      reason: route.reason,
      features: route.features,
      remaining_ms: remainingMs,
      scrape_id: meta.id,
      team_id: meta.internalOptions.teamId,
    });
  }
}
