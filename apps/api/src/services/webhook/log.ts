import { z } from "zod";

type WebhookLogFields = {
  host: string | null;
  events?: Array<string>;
  headerCount: number;
};

const stringSchema = z.string();
const unknownArraySchema = z.array(z.unknown());
const headersObjectSchema = z.looseObject({});

const webhookObjectSchema = z.object({
  url: z.unknown().optional(),
  events: z.unknown().optional(),
  headers: z.unknown().optional(),
});

const webhookFieldSchema = z.object({
  webhook: z.unknown(),
});

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Reduces a webhook (config object or bare URL string) to the fields logs
 * need: host, events and header count.
 */
export function summarizeWebhookForLog(
  webhook: unknown,
): WebhookLogFields | undefined {
  if (webhook === undefined || webhook === null) {
    return undefined;
  }
  if (typeof webhook === "string") {
    return { host: hostOf(webhook), headerCount: 0 };
  }
  const parsed = webhookObjectSchema.safeParse(webhook);
  if (!parsed.success) {
    return undefined;
  }

  const urlParsed = stringSchema.safeParse(parsed.data.url);
  const eventsParsed = unknownArraySchema.safeParse(parsed.data.events);
  const headersParsed = headersObjectSchema.safeParse(parsed.data.headers);
  return {
    host: urlParsed.success ? hostOf(urlParsed.data) : null,
    events: eventsParsed.success
      ? eventsParsed.data.filter((e): e is string => typeof e === "string")
      : undefined,
    headerCount: headersParsed.success
      ? Object.keys(headersParsed.data).length
      : 0,
  };
}

/** Returns a shallow copy of a request body with its `webhook` field summarized. */
export function withWebhookSummaryForLog<T>(body: T): T {
  if (!body || typeof body !== "object" || !("webhook" in body)) {
    return body;
  }
  const parsed = webhookFieldSchema.safeParse(body);
  if (!parsed.success) {
    return body;
  }
  return {
    ...body,
    webhook: summarizeWebhookForLog(parsed.data.webhook),
  };
}
