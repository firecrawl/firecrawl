import { Counter, Gauge, Histogram, register } from "prom-client";

const NAME = "pubsub_log_publish_total";

/**
 * Log rows handed to the Pub/Sub publisher, by table and outcome:
 * `published`, `failed` (publication or shutdown error), or `dropped` (backlog cap).
 * Use failed and dropped counts to detect losses between reconciliation checks.
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

export const pubsubLogPendingMessages =
  (register.getSingleMetric("pubsub_log_pending_messages") as
    | Gauge
    | undefined) ??
  new Gauge({
    name: "pubsub_log_pending_messages",
    help: "Log publications awaiting Pub/Sub acknowledgment in this process",
  });

export const pubsubLogPendingBytes =
  (register.getSingleMetric("pubsub_log_pending_bytes") as Gauge | undefined) ??
  new Gauge({
    name: "pubsub_log_pending_bytes",
    help: "Payload bytes awaiting Pub/Sub acknowledgment in this process",
  });

export const pubsubLogPublishDuration =
  (register.getSingleMetric("pubsub_log_publish_duration_seconds") as
    | Histogram<"table" | "outcome">
    | undefined) ??
  new Histogram({
    name: "pubsub_log_publish_duration_seconds",
    help: "Time until a publication succeeds or fails, including client retries",
    labelNames: ["table", "outcome"] as const,
    buckets: [0.01, 0.1, 1, 5, 15, 40, 60, 120, 300],
  });

export const pubsubLogShutdownTotal =
  (register.getSingleMetric("pubsub_log_shutdown_total") as
    | Counter<"outcome">
    | undefined) ??
  new Counter({
    name: "pubsub_log_shutdown_total",
    help: "Publisher drains by outcome: completed, failed, or timeout",
    labelNames: ["outcome"] as const,
  });
