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
 * What firebill said. `refused` is an explicit `success: false` — firebill does
 * not own the event and nobody else does, so usage is being dropped.
 * `ambiguous` is a transport failure: firebill may have accepted it before the
 * answer was lost. Both mean the caller was told false; only `refused` is proof
 * the usage is gone. Alert on the pair.
 */
export const firebillTrackTotal = new Counter({
  name: "firecrawl_firebill_track_total",
  help: "Outcomes of usage events sent to firebill",
  // operation: track|refund   outcome: accepted|refused|ambiguous
  labelNames: ["operation", "outcome"] as const,
});

/** Retries of a firebill call that answered `false` or threw. */
export const firebillRetryTotal = new Counter({
  name: "firecrawl_firebill_retry_total",
  help: "Retried firebill calls, by why the previous attempt failed",
  labelNames: ["reason"] as const, // not_ok | not_success | exception
});

/**
 * What firebill's credit check answered. `denied` is a real "cannot afford it"
 * and becomes a 402; `unavailable` means firebill could not answer, so the
 * caller **failed open** and the request proceeded unauthorized.
 *
 * Watch `unavailable`: unlike a refused charge it is invisible to the customer
 * and to the balance, so a firebill wobble here shows up nowhere else. And for
 * a gateway org `denied` means a partner's pool ran dry, which is a commercial
 * event rather than a fault.
 */
export const firebillCheckTotal = new Counter({
  name: "firecrawl_firebill_check_total",
  help: "Outcomes of credit checks sent to firebill",
  labelNames: ["outcome"] as const, // allowed | denied | unavailable
});
