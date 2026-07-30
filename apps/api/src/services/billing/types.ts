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
  // Set when the billed job scraped a document (PDF/office document). Routes
  // the charge to the DOCUMENT_CREDITS Autumn feature and participates in the
  // batch-billing grouping key so document and non-document charges for the
  // same team/endpoint refund against the correct pool. Only known after the
  // scrape resolves, so it is absent for endpoint-level (non-scrape) billing.
  isDocument?: boolean;
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
