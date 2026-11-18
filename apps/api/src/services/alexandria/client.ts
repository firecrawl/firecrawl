import { Agent, fetch } from "undici";
import { config } from "../../config";
import type { AlexandriaFeedbackStorage } from "../../lib/alexandria-feedback-storage";
import type { ExchangeResponse } from "./contracts";

const dispatcher = new Agent({
  connectTimeout: 10000,
  headersTimeout: 120_000,
  bodyTimeout: 120_000,
});

const CONNECTION_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "UND_ERR_SOCKET",
]);

const connectionFailed = (error: unknown) => {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && CONNECTION_ERRORS.has(code);
};

// A caller-supplied label as a short token that is safe in a header, or nothing.
const headerToken = (value: string | null | undefined) => {
  const token = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .slice(0, 64);
  return /[a-z0-9]/.test(token) ? token : undefined;
};

export async function exchangeRequest(input: {
  teamId: string;
  path: string;
  body?: unknown;
  timeoutMs: number;
  requestId?: string;
  maximumCredits?: number;
  resultAuthorization?: string;
  termsIdentity?: { organizationId: string; apiKeyId: string };
  /** The organization a provider call bills against, so Exchange can attribute a paid read. Grants nothing. */
  billingOrganizationId?: string;
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
  /** The team may only be served by US-based providers. */
  usOnly?: boolean;
  /** The team carries the Alexandria Verified flag, so Exchange runs its verifiedOnly providers. */
  alexandriaVerified?: boolean;
  /** Send once more when the connection fails before an answer. Only for requests that change nothing. */
  retryConnection?: boolean;
  /** Trusted internal marker for zero-priced provider lines, sent with the internal secret so Exchange can verify it. */
  ultrasearch?: boolean;
  /** Whether Alexandria feedback from this team may be stored, and the reason when it may not. */
  feedbackStorage?: AlexandriaFeedbackStorage;
  /** The caller's origin and integration as the request named them; sent as short tokens. */
  clientOrigin?: string | null;
  clientIntegration?: string | null;
}): Promise<ExchangeResponse> {
  if (!config.FIRE_EXCHANGE_URL)
    throw new Error("Alexandria is not configured");
  const clientOrigin = headerToken(input.clientOrigin);
  const clientIntegration = headerToken(input.clientIntegration);
  const base = config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
  const signal = AbortSignal.timeout(Math.max(1, input.timeoutMs));
  const init = {
    method: input.body === undefined ? "GET" : "POST",
    redirect: "manual" as const,
    dispatcher,
    signal,
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
      ...(input.billingOrganizationId
        ? {
            "x-exchange-billing-organization-id": input.billingOrganizationId,
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
      ...(input.usOnly ? { "x-exchange-us-only": "true" } : {}),
      ...(input.alexandriaVerified
        ? { "x-exchange-alexandria-verified": "true" }
        : {}),
      ...(input.ultrasearch && config.EXCHANGE_INTERNAL_SECRET
        ? {
            "x-exchange-ultrasearch": "true",
            "x-exchange-secret": config.EXCHANGE_INTERNAL_SECRET,
          }
        : {}),
      ...(input.feedbackStorage
        ? { "x-exchange-feedback-storage": input.feedbackStorage }
        : {}),
      ...(clientOrigin ? { "x-exchange-client-origin": clientOrigin } : {}),
      ...(clientIntegration
        ? { "x-exchange-client-integration": clientIntegration }
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
  };
  const response = await fetch(base + input.path, init).catch(error => {
    if (!input.retryConnection || signal.aborted || !connectionFailed(error))
      throw error;
    return fetch(base + input.path, init);
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
