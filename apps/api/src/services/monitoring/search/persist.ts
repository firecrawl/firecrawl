import { canonicalizeUrl } from "./dedupe";
import type { KnownPage, KnownEvent } from "./run";

export function searchStatusToPageStatus(
  status: string,
): "same" | "new" | "changed" | "removed" | "error" {
  if (status === "alert") return "new";
  if (status === "skipped") return "error";
  return "same";
}

type PriorPage = {
  url: string;
  metadata: unknown | null;
  updated_at?: string;
  last_status?: string;
};

export function reconstructKnownState(
  priorPages: PriorPage[],
  goalVersion: string,
): { knownPages: Map<string, KnownPage>; knownEvents: KnownEvent[] } {
  const knownPages = new Map<string, KnownPage>();
  const eventsByKey = new Map<string, KnownEvent & { lastSeenAt: string }>();
  for (const page of priorPages) {
    const meta = (page.metadata ?? {}) as Record<string, unknown>;
    if (
      typeof meta.fingerprint === "string" &&
      typeof meta.goalVersion === "string"
    ) {
      knownPages.set(canonicalizeUrl(page.url), {
        fingerprint: meta.fingerprint,
        goalVersion: meta.goalVersion,
        lastCheckedAt: page.updated_at,
        lastStatus:
          typeof meta.searchStatus === "string"
            ? meta.searchStatus
            : page.last_status,
        metadata: meta,
      });
    }
    if (meta.goalVersion === goalVersion && typeof meta.eventKey === "string") {
      const existing = eventsByKey.get(meta.eventKey);
      const seenAt = page.updated_at ?? "";
      const satisfiedAt =
        typeof meta.eventSatisfiedAt === "string"
          ? meta.eventSatisfiedAt
          : undefined;
      const alertCount =
        typeof meta.eventAlertCount === "number"
          ? meta.eventAlertCount
          : undefined;
      if (!existing) {
        eventsByKey.set(meta.eventKey, {
          key: meta.eventKey,
          label:
            typeof meta.eventLabel === "string"
              ? meta.eventLabel
              : meta.eventKey,
          lastSeenAt: seenAt,
          ...(satisfiedAt ? { satisfiedAt } : {}),
          ...(alertCount !== undefined ? { alertCount } : {}),
        });
      } else {
        if (seenAt > existing.lastSeenAt) {
          existing.lastSeenAt = seenAt;
        }
        if (
          satisfiedAt &&
          (!existing.satisfiedAt || satisfiedAt < existing.satisfiedAt)
        ) {
          existing.satisfiedAt = satisfiedAt;
        }
        if (
          alertCount !== undefined &&
          (existing.alertCount === undefined ||
            alertCount > existing.alertCount)
        ) {
          existing.alertCount = alertCount;
        }
      }
    }
  }
  const knownEvents = [...eventsByKey.values()]
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
    .map(({ lastSeenAt: _ignored, ...event }) => event);
  return { knownPages, knownEvents };
}
