import { z } from "zod";

const BLACKLISTED_WEBHOOK_HEADERS = ["x-firecrawl-signature"];

export const webhookSchema = z.preprocess(
  x => (typeof x === "string" ? { url: x } : x),
  z
    .strictObject({
      url: z.url(),
      headers: z.record(z.string(), z.string()).prefault({}),
      metadata: z.record(z.string(), z.string()).prefault({}),
      events: z
        .array(z.enum(["completed", "failed", "page", "started"]))
        .prefault(["completed", "failed", "page", "started"]),
    })
    .refine(
      obj => {
        const blacklistedLower = BLACKLISTED_WEBHOOK_HEADERS.map(h =>
          h.toLowerCase(),
        );
        return !Object.keys(obj.headers).some(key =>
          blacklistedLower.includes(key.toLowerCase()),
        );
      },
      `The following headers are not allowed: ${BLACKLISTED_WEBHOOK_HEADERS.join(", ")}`,
    ),
);
