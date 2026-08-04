import type { NuQJobStatus } from "../services/worker/nuq-router";

export type CrawlWebSocketStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "scraping";

export function shouldCloseCrawlStatusWS(
  jobCount: number,
  completedJobCount: number,
  kickoffFinished: boolean,
): boolean {
  return kickoffFinished && jobCount === completedJobCount;
}

export function deriveCrawlStatus(
  cancelled: boolean,
  validJobStatuses: ReadonlyArray<readonly [string, NuQJobStatus]>,
): CrawlWebSocketStatus {
  if (cancelled) return "cancelled";

  // An empty list means the crawl is still being initialized. Require at least
  // one visible job before reporting a crawl as completed.
  if (
    validJobStatuses.length > 0 &&
    validJobStatuses.every(([, status]) => status === "completed")
  ) {
    return "completed";
  }

  return "scraping";
}
