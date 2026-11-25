export type BillingEndpoint =
  | "agent"
  | "batch_scrape"
  | "browser"
  | "crawl"
  | "deep_research"
  | "extract"
  | "fresh_feed"
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
  chargeId?: string;
  externalRequestId?: string | null;
  hostedMcp?: boolean;
};
