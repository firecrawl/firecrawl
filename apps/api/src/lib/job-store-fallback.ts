import { Counter, register } from "prom-client";
import { config } from "../config";
import { logger } from "./logger";

const NAME = "job_store_postgres_fallback_total";

/**
 * Reads the new job stores (Bigtable, NuQ) could not answer and PostgreSQL
 * did. Each label is one fallback path; a store is ready to lose its
 * fallback once its series has stayed flat for the agreed window.
 *
 * Looked up before creation so a re-evaluated module (test isolation) does
 * not register the same series twice in the shared default registry.
 */
export const jobStorePostgresFallbackTotal =
  (register.getSingleMetric(NAME) as Counter<"store"> | undefined) ??
  new Counter({
    name: NAME,
    help: "Job-store reads answered by the PostgreSQL fallback, by store",
    labelNames: ["store"] as const,
  });

type JobStoreFallback =
  | "job_access"
  | "scrape_state"
  | "extract_state"
  | "feedback_job"
  | "request_credits"
  | "change_tracking";

/**
 * The Bigtable table behind each store. When it is not configured the
 * primary store never answers, PostgreSQL is the only store, and a hit is
 * not a fallback worth counting.
 */
const STORE_TABLE: Record<JobStoreFallback, () => string | undefined> = {
  job_access: () => config.BIGTABLE_JOB_ACCESS_TABLE,
  scrape_state: () => config.BIGTABLE_SCRAPE_STATE_TABLE,
  extract_state: () => config.BIGTABLE_EXTRACT_STATE_TABLE,
  feedback_job: () => config.BIGTABLE_FEEDBACK_JOBS_TABLE,
  request_credits: () => config.BIGTABLE_REQUEST_CREDITS_TABLE,
  change_tracking: () => config.BIGTABLE_CHANGE_TRACKING_TABLE,
};

/**
 * Record that PostgreSQL served a row the primary store did not have. Call
 * it only on a genuine miss: a miss on both sides is a normal "not found",
 * and a primary-store *error* is already reported where it is caught and
 * must not keep this series hot. Deployments without the store configured
 * record nothing.
 */
export function recordJobStorePostgresFallback(
  store: JobStoreFallback,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  if (!STORE_TABLE[store]()) return;
  jobStorePostgresFallbackTotal.inc({ store });
  logger.info("PostgreSQL fallback served a job-store read", {
    ...extra,
    module: "job-store-fallback",
    store,
    id,
  });
}
