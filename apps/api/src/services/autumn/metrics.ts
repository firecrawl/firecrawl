import { Counter } from "prom-client";

/**
 * Which path a usage event took. The ratio of `firebill` to `direct` is the
 * live read on the rollout percentage — during a ramp it is the first thing to
 * look at, because a routing bug shows up here long before it shows up in a
 * balance.
 */
export const billingRouteTotal = new Counter({
  name: "firecrawl_billing_route_total",
  help: "Usage events by the path they took to Autumn",
  labelNames: ["route"] as const, // firebill | direct
});

/**
 * What firebill said. `refused` is the one that matters: firebill answered
 * `success: false`, so it does NOT own the event and nobody else does either —
 * usage is being dropped. Alert on it.
 */
export const firebillTrackTotal = new Counter({
  name: "firecrawl_firebill_track_total",
  help: "Outcomes of usage events sent to firebill",
  labelNames: ["path", "outcome"] as const, // track|refund × accepted|refused
});

/** Retries of a firebill call that answered `false` or threw. */
export const firebillRetryTotal = new Counter({
  name: "firecrawl_firebill_retry_total",
  help: "Retried firebill calls, by why the previous attempt failed",
  labelNames: ["reason"] as const, // not_ok | not_success | exception
});
