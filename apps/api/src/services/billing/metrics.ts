import { Counter } from "prom-client";

/**
 * Billing operations whose usage no system records. The request-time track is
 * the only charge, so an operation that reached the batch without one is
 * usage that nobody billed.
 *
 * - `no_org` — the team has no org, so there was no Autumn customer to track.
 * - `track_failed` — the team has an org, but the request-time track did not
 *   succeed.
 */
export const billingUnrecordedUsageTotal = new Counter({
  name: "firecrawl_billing_unrecorded_usage_total",
  help: "Billing operations whose usage was not tracked at request time",
  labelNames: ["reason"] as const, // no_org | track_failed
});
