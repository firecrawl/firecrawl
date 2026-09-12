import { Agent, fetch } from "undici";
import { config } from "../../config";
import type { ExchangeResponse } from "./contracts";

const dispatcher = new Agent({
  connectTimeout: 10000,
  headersTimeout: 50000,
  bodyTimeout: 50000,
});

export async function exchangeRequest(input: {
  teamId: string;
  path: string;
  body?: unknown;
  timeoutMs: number;
  requestId?: string;
  maximumCredits?: number;
  internal?: boolean;
}): Promise<ExchangeResponse> {
  if (!config.FIRE_EXCHANGE_URL) throw new Error("Exchange is not configured");
  const base = config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
  if (
    input.internal &&
    (!config.EXCHANGE_INTERNAL_SECRET || new URL(base).protocol !== "https:")
  )
    throw new Error("Exchange billing requires HTTPS and an internal secret");
  const response = await fetch(base + input.path, {
    method: input.body === undefined ? "GET" : "POST",
    redirect: "manual",
    dispatcher,
    signal: AbortSignal.timeout(Math.max(1, input.timeoutMs)),
    headers: {
      "content-type": "application/json",
      "x-exchange-team-id": input.teamId,
      "x-exchange-extended-catalog-access": "true",
      ...(input.requestId ? { "x-request-id": input.requestId } : {}),
      ...(input.maximumCredits === undefined
        ? {}
        : {
            "x-exchange-max-credits": String(input.maximumCredits),
            "x-exchange-deadline": String(
              Date.now() +
                input.timeoutMs -
                Math.min(2000, input.timeoutMs / 10),
            ),
          }),
      ...(input.internal
        ? { "x-exchange-secret": config.EXCHANGE_INTERNAL_SECRET! }
        : {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  // Bound retained provider responses, including bodies without Content-Length.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024)
      throw new Error("Exchange response is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
}
