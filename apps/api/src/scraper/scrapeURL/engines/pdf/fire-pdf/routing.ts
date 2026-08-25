import { createHash } from "node:crypto";
import { MIN_DEADLINE_MS } from "./schema";

export const FIRE_PDF_ASYNC_MIN_REMAINING_MS = MIN_DEADLINE_MS + 10_000;

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
