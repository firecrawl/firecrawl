export type BillingEndpoint =
  | "agent"
  | "batch_scrape"
  | "browser"
  | "crawl"
  | "deep_research"
  | "extract"
  | "fireclaw"
  | "interact"
  | "llms_txt"
  | "map"
  | "monitor"
  | "parse"
  | "scrape"
  | "search";

export type BillingMetadata = {
  endpoint: BillingEndpoint;
  jobId?: string;
  /**
   * Unique-per-CHARGE identity, set by the call site that knows what "one
   * charge" is. billTeam derives the firebill idempotency key from it
   * (`fc:track:{endpoint}:{chargeId}`), so a retried call — or a re-run job —
   * dedupes instead of double-billing on the firebill route.
   *
   * Rules: it must never be shared by two charges that should BOTH bill
   * (collision = silent underbilling). A jobId shared with another charge on
   * the same endpoint needs a suffix (e.g. `${extractId}:threat` for the
   * threat-scan fee vs the extract's main charge). Sites with no unique
   * identity (fireclaw, grouped charges) leave it unset and keep firebill's
   * per-request UUID, which dedupes only firebill's own retries.
   */
  chargeId?: string;
};

export function resolveBillingMetadata({
  billing,
  isExtract = false,
  crawlId,
  crawlerOptions,
}: {
  billing?: BillingMetadata;
  isExtract?: boolean;
  crawlId?: string;
  crawlerOptions?: unknown;
}): BillingMetadata {
  if (billing) return billing;
  if (crawlId) {
    return {
      endpoint: crawlerOptions == null ? "batch_scrape" : "crawl",
    };
  }
  return {
    endpoint: isExtract ? "extract" : "scrape",
  };
}

export function toAutumnBillingProperties(
  billing: BillingMetadata,
): Record<string, string> {
  const props: Record<string, string> = { endpoint: billing.endpoint };
  if (billing.jobId) {
    props.jobId = billing.jobId;
  }
  return props;
}
