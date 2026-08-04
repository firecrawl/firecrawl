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
  jobCount: number,
  failedJobCount: number,
  validJobStatuses: ReadonlyArray<readonly [string, NuQJobStatus]>,
): CrawlWebSocketStatus {
  if (cancelled) return "cancelled";

  if (jobCount > 0 && jobCount === failedJobCount) {
    return "completed";
  }

  if (
    validJobStatuses.length > 0 &&
    validJobStatuses.every(([, status]) => status === "completed")
  ) {
    return "completed";
  }

  return "scraping";
}
