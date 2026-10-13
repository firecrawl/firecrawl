import { z } from "zod";
import {
  FIRECRAWL_MANAGED_WEBHOOK_HEADERS,
  isFirecrawlManagedWebhookHeader,
} from "./headers";

const BLACKLISTED_WEBHOOK_HEADERS = [...FIRECRAWL_MANAGED_WEBHOOK_HEADERS];

export function createWebhookSchema<T extends [string, ...string[]]>(
  events: T,
) {
  return z.preprocess(
    x => (typeof x === "string" ? { url: x } : x),
    z
      .strictObject({
        url: z.url(),
        headers: z.record(z.string(), z.string()).prefault({}),
        metadata: z.record(z.string(), z.string()).prefault({}),
        events: z.array(z.enum(events)).prefault([...events]),
      })
      .refine(
        obj => !Object.keys(obj.headers).some(isFirecrawlManagedWebhookHeader),
        `The following headers are not allowed: ${BLACKLISTED_WEBHOOK_HEADERS.join(", ")}`,
      ),
  );
}

export const webhookSchema = createWebhookSchema([
  "completed",
  "failed",
  "page",
  "started",
]);
