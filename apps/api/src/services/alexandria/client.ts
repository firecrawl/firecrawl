import { Agent, fetch } from "undici";
import { config } from "../../config";
import type { ExchangeResponse } from "./contracts";

const dispatcher = new Agent({
  connectTimeout: 10000,
  headersTimeout: 120_000,
  bodyTimeout: 120_000,
});

export async function exchangeRequest(input: {
  teamId: string;
  path: string;
  body?: unknown;
  timeoutMs: number;
  requestId?: string;
  maximumCredits?: number;
  resultAuthorization?: string;
  termsIdentity?: { organizationId: string; apiKeyId: string };
  /** Caller's IP as the API sees it; Exchange resolves what it needs from it. */
  clientIp?: string;
  /** Country on the team's billing address, when it has one. */
  billingCountry?: string;
  /**
   * The team may use its own MCP connectors (Alexandria connectors). Sent for teams with the
   * `exchangeRetrieve` flag, which is the connectors whitelist; Exchange reads it as the grant.
   */
  connectors?: boolean;
  zeroDataRetention?: boolean;
}): Promise<ExchangeResponse> {
  if (!config.FIRE_EXCHANGE_URL)
    throw new Error("Alexandria is not configured");
  const base = config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
  const response = await fetch(base + input.path, {
    method: input.body === undefined ? "GET" : "POST",
    redirect: "manual",
    dispatcher,
    signal: AbortSignal.timeout(Math.max(1, input.timeoutMs)),
    headers: {
      "content-type": "application/json",
      ...(input.resultAuthorization
        ? { authorization: input.resultAuthorization }
        : {}),
      "x-exchange-team-id": input.teamId,
      ...(input.termsIdentity
        ? {
            "x-exchange-organization-id": input.termsIdentity.organizationId,
            "x-exchange-api-key-id": input.termsIdentity.apiKeyId,
          }
        : {}),
      "x-exchange-extended-catalog-access": "true",
      ...(input.clientIp ? { "x-exchange-client-ip": input.clientIp } : {}),
      ...(input.billingCountry
        ? { "x-exchange-billing-country": input.billingCountry }
        : {}),
      ...(input.connectors ? { "x-exchange-connectors": "true" } : {}),
      ...(input.zeroDataRetention
        ? { "x-exchange-zero-data-retention": "true" }
        : {}),
      ...(input.requestId ? { "x-request-id": input.requestId } : {}),
      ...(input.maximumCredits === undefined
        ? {}
        : {
            "x-exchange-max-credits": String(input.maximumCredits),
            // Leave the Exchange a margin to answer before our own timeout.
            "x-exchange-deadline": String(
              Math.floor(
                Date.now() +
                  input.timeoutMs -
                  Math.min(2000, input.timeoutMs / 10),
              ),
            ),
          }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  // Bound retained provider responses, including bodies without Content-Length.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024)
      throw new Error("Alexandria response is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
}
