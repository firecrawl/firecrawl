import { getScrapeZDR, getSearchZDR } from "../../../lib/zdr-helpers";
import type { RequestWithAuth } from "../types";
import type { FeedbackJobRow, FeedbackRecordOptions } from "./internal-types";

type SearchOptions = {
  enterprise?: unknown;
};

function searchOptionsUseZdr(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;

  const enterprise = (options as SearchOptions).enterprise;
  return (
    Array.isArray(enterprise) &&
    (enterprise.includes("zdr") || enterprise.includes("anon"))
  );
}

export function shouldSkipPersistenceForForcedZdr(
  req: RequestWithAuth<any, any, any>,
  options: FeedbackRecordOptions,
): boolean {
  if (options.skipZdrPersistence === false) return false;

  if (options.endpoint === "search") {
    const searchZDR = getSearchZDR(req.acuc?.flags);
    return searchZDR === "forced-zdr" || searchZDR === "forced-anon";
  }

  if (options.endpoint === "scrape" || options.endpoint === "parse") {
    return getScrapeZDR(req.acuc?.flags) === "forced";
  }

  return false;
}

export function shouldSkipPersistenceForJobZdr(
  job: FeedbackJobRow,
  options: FeedbackRecordOptions,
): boolean {
  if (options.skipZdrPersistence === false) return false;

  if (job.endpoint === "search") {
    return searchOptionsUseZdr(job.options);
  }

  if (job.endpoint === "scrape" || job.endpoint === "parse") {
    return job.options === null;
  }

  return false;
}
