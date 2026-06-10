import { createHmac } from "crypto";

export const FIRECRAWL_MANAGED_WEBHOOK_HEADERS = [
  "X-Firecrawl-Signature",
  "X-Firecrawl-Webhook-Id",
  "X-Firecrawl-Event",
  "X-Firecrawl-Job-Id",
  "X-Firecrawl-Scrape-Id",
  "X-Firecrawl-Delivery-Mode",
] as const;

const FIRECRAWL_MANAGED_WEBHOOK_HEADERS_LOWER =
  FIRECRAWL_MANAGED_WEBHOOK_HEADERS.map(header => header.toLowerCase());

export function isFirecrawlManagedWebhookHeader(header: string): boolean {
  return FIRECRAWL_MANAGED_WEBHOOK_HEADERS_LOWER.includes(header.toLowerCase());
}

export function buildWebhookDeliveryHeaders(params: {
  configHeaders?: Record<string, string>;
  deliveryMode: "direct" | "queued";
  jobId: string;
  payload: {
    type: string;
    webhookId: string;
  };
  payloadString: string;
  scrapeId?: string;
  secret?: string;
}): Record<string, string> {
  const customerHeaders = Object.fromEntries(
    Object.entries(params.configHeaders ?? {}).filter(
      ([header]) => !isFirecrawlManagedWebhookHeader(header),
    ),
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...customerHeaders,
    "X-Firecrawl-Webhook-Id": params.payload.webhookId,
    "X-Firecrawl-Event": params.payload.type,
    "X-Firecrawl-Job-Id": params.jobId,
    "X-Firecrawl-Delivery-Mode": params.deliveryMode,
  };

  if (params.scrapeId) {
    headers["X-Firecrawl-Scrape-Id"] = params.scrapeId;
  }

  if (params.secret) {
    const hmac = createHmac("sha256", params.secret);
    hmac.update(params.payloadString);
    headers["X-Firecrawl-Signature"] = `sha256=${hmac.digest("hex")}`;
  }

  return headers;
}
