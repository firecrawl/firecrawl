import { getCrawl, type StoredCrawl } from "./crawl-redis";
import { crawlGroup } from "../services/worker/nuq-router";

type AppendCheck =
  | { crawl: StoredCrawl }
  | { status: 404 | 409; error: string };

/** A terminal batch cannot account for new jobs without a new lifecycle. */
export async function validateBatchAppend(
  id: string,
  teamId: string,
): Promise<AppendCheck> {
  const crawl = await getCrawl(id);
  if (!crawl || crawl.team_id !== teamId) {
    return { status: 404, error: "Job not found" };
  }

  const group = await crawlGroup.getGroup(id);
  if (!group) {
    return { status: 404, error: "Job not found" };
  }

  if (crawl.cancelled || group.status !== "active") {
    return {
      status: 409,
      error:
        "Cannot append URLs to a completed or cancelled batch. Start a new batch without appendToId.",
    };
  }

  return { crawl };
}
