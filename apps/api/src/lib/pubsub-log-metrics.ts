import { Counter, register } from "prom-client";

const NAME = "pubsub_log_publish_total";

/**
 * Log rows handed to the Pub/Sub publisher, by table and outcome:
 * `published`, `failed` (every retry exhausted), or `dropped` (backlog cap).
 * A channel stall shows up here as `failed` and `dropped` rising together,
 * without waiting for the daily reconciliation against PostgreSQL.
 *
 * Looked up before creation so a re-evaluated module (test isolation) does
 * not register the same series twice in the shared default registry.
 */
export const pubsubLogPublishTotal =
  (register.getSingleMetric(NAME) as
    | Counter<"table" | "outcome">
    | undefined) ??
  new Counter({
    name: NAME,
    help: "Log rows handed to the Pub/Sub publisher, by table and outcome",
    labelNames: ["table", "outcome"] as const,
  });
