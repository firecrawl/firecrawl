import { z } from "zod";

const BLACKLISTED_WEBHOOK_HEADERS = ["x-firecrawl-signature"];

export function createWebhookSchema<T extends [string, ...string[]]>(
  events: T,
) {
  const blacklistedLower = BLACKLISTED_WEBHOOK_HEADERS.map(h =>
    h.toLowerCase(),
  );
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
        obj =>
          !Object.keys(obj.headers).some(key =>
            blacklistedLower.includes(key.toLowerCase()),
          ),
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
