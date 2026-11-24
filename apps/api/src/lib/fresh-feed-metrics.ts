import { Counter, Histogram } from "prom-client";
import { FRESH_FEED_UPSTREAMS } from "./fresh-feed";

export const freshFeedUpstreamRequestDurationSeconds = new Histogram({
  name: "fresh_feed_upstream_request_duration_seconds",
  help: "Duration of upstream fresh feed requests in seconds",
  labelNames: ["upstream", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

export const freshFeedBillingCountErrorsTotal = new Counter({
  name: "fresh_feed_billing_count_errors_total",
  help: "Delivered 200 fresh feed responses whose records could not be counted for billing",
  labelNames: ["upstream"] as const,
});

for (const upstream of FRESH_FEED_UPSTREAMS) {
  freshFeedBillingCountErrorsTotal.inc({ upstream }, 0);
}
