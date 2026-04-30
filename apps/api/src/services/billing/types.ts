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
