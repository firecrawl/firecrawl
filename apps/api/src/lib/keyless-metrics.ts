import { Counter } from "prom-client";

// Fixed labels only: never put IPs, team IDs, or caller-provided values here.
export const keylessAuthTotal = new Counter({
  name: "firecrawl_keyless_auth_total",
  help: "Keyless auth decisions; allowed does not imply downstream success",
  labelNames: ["mode", "outcome"],
});

export const keylessCreditBlocksTotal = new Counter({
  name: "firecrawl_keyless_credit_blocks_total",
  help: "Projected-credit quota blocks after keyless auth allowed a request",
});

export const keylessCreditsTotal = new Counter({
  name: "firecrawl_keyless_credits_total",
  help: "Actual keyless credits consumed, excluding provisional reservations",
});

export const spurEventsTotal = new Counter({
  name: "firecrawl_spur_events_total",
  help: "Spur lookup, cache, suspicious verdict and error events; a check may emit multiple events and includes eligibility probes",
  labelNames: ["event"],
});

export const spurBypassesTotal = new Counter({
  name: "firecrawl_spur_bypasses_total",
  help: "Spur checks skipped or failed open without a reputation result; includes eligibility probes, not necessarily admitted requests",
  labelNames: ["reason"],
});
