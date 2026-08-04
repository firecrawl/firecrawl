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

type DeriveCrawlStatusOptions = {
  cancelled: boolean;
  kickoffFinished: boolean;
  jobCount: number;
  failedJobCount: number;
  validJobStatuses: ReadonlyArray<readonly [string, NuQJobStatus]>;
};

export function deriveCrawlStatus({
  cancelled,
  kickoffFinished,
  jobCount,
  failedJobCount,
  validJobStatuses,
}: DeriveCrawlStatusOptions): CrawlWebSocketStatus {
  if (cancelled) return "cancelled";

  if (!kickoffFinished) return "scraping";

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
