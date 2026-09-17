import { Counter, register } from "prom-client";
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
 * Record that PostgreSQL served a row the primary store did not have. Call
 * it only on a hit: a miss on both sides is a normal "not found".
 */
export function recordJobStorePostgresFallback(
  store: JobStoreFallback,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  jobStorePostgresFallbackTotal.inc({ store });
  logger.info("PostgreSQL fallback served a job-store read", {
    module: "job-store-fallback",
    store,
    id,
    ...extra,
  });
}
