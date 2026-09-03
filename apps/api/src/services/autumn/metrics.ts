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

/**
 * **Who failed, when a firebill call did not produce a usable answer.**
 *
 * A separate series rather than a `cause` label on the counters above, and that
 * is the whole point. `increase()` evaluates per series, so
 * `increase(firecrawl_firebill_check_total{outcome="unavailable"}[15m]) > 5` —
 * the live `FirebillCheckUnavailable` rule — would silently start comparing 5
 * against each cause on its own: two causes sitting at 4 apiece would be 8
 * unanswered credit checks that nobody is paged about. The counters those rules
 * read stay byte-for-byte what they were; this one adds the detail beside them.
 *
 * - `timeout` / `connection` — the request never completed. **A client-side or
 *   transport failure, not firebill**: it never answered, and its own
 *   server-side p99 may be fine (73ms, while ~1,800 of these were logged per
 *   30h against a 5s client deadline).
 * - `non_ok` — firebill answered, with a status we cannot use.
 * - `unusable` — firebill answered, and the answer is not one we can read.
 *   Never proof that anything was lost.
 * - `refused` — firebill answered `success: false`: on a track it did not take
 *   the event, on a check it declined to answer.
 * - `ambiguous` — firebill answered "I do not know" (a 504, or
 *   `ambiguous: true`).
 *
 * Only incremented on failure, so a healthy service produces no series at all.
 */
export const firebillFailureCauseTotal = new Counter({
  name: "firecrawl_firebill_failure_cause_total",
  help: "Why a firebill call did not produce a usable answer",
  // operation: track|refund|check|lock|finalize
  // cause: timeout|connection|non_ok|unusable|refused|ambiguous
  labelNames: ["operation", "cause"] as const,
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
