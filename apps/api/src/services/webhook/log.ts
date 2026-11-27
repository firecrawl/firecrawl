type WebhookLogFields = {
  host: string | null;
  events?: string[];
  headerCount: number;
};

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
  if (webhook === undefined || webhook === null) return undefined;
  if (typeof webhook === "string") {
    return { host: hostOf(webhook), headerCount: 0 };
  }
  if (typeof webhook !== "object") return undefined;

  const { url, events, headers } = webhook as Record<string, unknown>;
  return {
    host: typeof url === "string" ? hostOf(url) : null,
    events: Array.isArray(events)
      ? events.filter((e): e is string => typeof e === "string")
      : undefined,
    headerCount:
      headers && typeof headers === "object" ? Object.keys(headers).length : 0,
  };
}

/** Returns a shallow copy of a request body with its `webhook` field summarized. */
export function withWebhookSummaryForLog<T>(body: T): T {
  if (!body || typeof body !== "object" || !("webhook" in body)) return body;
  return {
    ...body,
    webhook: summarizeWebhookForLog((body as { webhook: unknown }).webhook),
  };
}
