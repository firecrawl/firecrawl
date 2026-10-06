import { createHmac, randomBytes } from "node:crypto";
import { Counter } from "prom-client";
import { z } from "zod";
import { config } from "../config";
import type { AgentHintEndpoint } from "./agent-hints";
import type { KeylessSignupSurface } from "./keyless-signup-link";
import { logger } from "./logger";

/**
 * Optional external agent hints provider. When AGENT_HINTS_PROVIDER_URL is
 * set, hint-enabled requests ask a separate HTTP service for additional
 * guidance. The lookup starts after auth and is never awaited: the response
 * only carries provider hints that have already arrived (or are cached) by
 * the time it is sent. Every failure means "no provider hints".
 */
export type ProviderHint = { id: string; text: string };

/** Shared by every request for the same cache key; read-only for callers. */
export type ProviderHintsHolder = { settled: boolean; hints: ProviderHint[] };

export type AgentHintsProviderContext = {
  teamId: string;
  orgId: string | null;
  apiKeyId: number | null;
  endpoint: AgentHintEndpoint;
  surface: KeylessSignupSurface;
  keyless: boolean;
};

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 600;
const NEGATIVE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;
const MAX_HINT_ID_LENGTH = 64;
const MAX_HINT_TEXT_LENGTH = 500;
const MAX_STORED_HINTS = 10;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PROVIDER_HINTS = 2;
const MAX_TOTAL_HINTS = 3;

// Fixed labels only: never put team IDs or provider-supplied values here.
export const agentHintsProviderRequestsTotal = new Counter({
  name: "firecrawl_agent_hints_provider_requests_total",
  help: "External agent hints provider lookups by outcome: hit (served from cache or joined an in-flight fetch), miss (fetch started), timeout, error, disabled (no provider configured)",
  labelNames: ["outcome"],
});

const responseSchema = z.object({
  hints: z.array(z.unknown()),
  ttl_seconds: z.number().finite().optional().catch(undefined),
});

const processPseudonymKey = randomBytes(32);

/**
 * Keyless team IDs identify a client address, so the provider receives a
 * pseudonym instead: HMAC-SHA256 keyed by AGENT_HINTS_PROVIDER_PSEUDONYM_KEY,
 * which is never sent to the provider, or by a random per-process key.
 */
export function providerTeamId(teamId: string): string {
  if (!teamId.startsWith("preview_keyless_")) return teamId;
  const digest = createHmac(
    "sha256",
    config.AGENT_HINTS_PROVIDER_PSEUDONYM_KEY ?? processPseudonymKey,
  )
    .update(teamId)
    .digest("hex");
  return `keyless_${digest}`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Response body too large");
  }
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Response body too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type CacheEntry = { holder: ProviderHintsHolder; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function sanitize(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\p{Cc}/gu, " ").trim();
  return cleaned && cleaned.length <= maxLength ? cleaned : undefined;
}

function sanitizeHints(values: unknown[]): ProviderHint[] {
  const hints: ProviderHint[] = [];
  for (const value of values) {
    if (hints.length >= MAX_STORED_HINTS) break;
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    const id = sanitize(raw.id, MAX_HINT_ID_LENGTH);
    const text = sanitize(raw.text, MAX_HINT_TEXT_LENGTH);
    if (id && text) hints.push({ id, text });
  }
  return hints;
}

async function fetchProviderHints(
  url: string,
  context: AgentHintsProviderContext,
): Promise<{ hints: ProviderHint[]; ttlMs: number }> {
  const secret = config.AGENT_HINTS_PROVIDER_SECRET;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        version: 1,
        team_id: providerTeamId(context.teamId),
        org_id: context.orgId,
        api_key_id: context.apiKeyId,
        endpoint: context.endpoint,
        surface: context.surface,
        keyless: context.keyless,
      }),
      signal: AbortSignal.timeout(config.AGENT_HINTS_PROVIDER_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Unexpected status ${response.status}`);
    }
    const parsed = responseSchema.safeParse(await readJsonBody(response));
    if (!parsed.success) throw new Error("Malformed response body");
    const ttlSeconds = Math.min(
      Math.max(parsed.data.ttl_seconds ?? DEFAULT_TTL_SECONDS, 0),
      MAX_TTL_SECONDS,
    );
    return {
      hints: sanitizeHints(parsed.data.hints),
      ttlMs: ttlSeconds * 1000,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    agentHintsProviderRequestsTotal.inc({
      outcome: timedOut ? "timeout" : "error",
    });
    logger.debug("Agent hints provider lookup failed", {
      module: "agent-hints-provider",
      endpoint: context.endpoint,
      timedOut,
      error: error instanceof Error ? error.message : String(error),
    });
    return { hints: [], ttlMs: NEGATIVE_TTL_MS };
  }
}

/**
 * Returns the cached or in-flight lookup for this team, endpoint and surface,
 * starting a fetch on a miss. Never throws and never blocks. Returns undefined
 * when no provider is configured.
 */
export function getProviderHints(
  context: AgentHintsProviderContext,
): ProviderHintsHolder | undefined {
  const url = config.AGENT_HINTS_PROVIDER_URL;
  if (!url) {
    agentHintsProviderRequestsTotal.inc({ outcome: "disabled" });
    return undefined;
  }

  const key = `${context.teamId}|${context.endpoint}|${context.surface}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    agentHintsProviderRequestsTotal.inc({ outcome: "hit" });
    return cached.holder;
  }

  agentHintsProviderRequestsTotal.inc({ outcome: "miss" });
  cache.delete(key);
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const entry: CacheEntry = {
    holder: { settled: false, hints: [] },
    expiresAt: Infinity,
  };
  cache.set(key, entry);
  void fetchProviderHints(url, context).then(({ hints, ttlMs }) => {
    entry.holder.hints = hints;
    entry.holder.settled = true;
    entry.expiresAt = Date.now() + ttlMs;
  });
  return entry.holder;
}

/**
 * Deterministic hints first and never dropped, then provider hints that are
 * not exact duplicates, up to the provider and total caps.
 */
export function mergeAgentHints(
  deterministic: string[],
  provider: ProviderHint[],
): { hints: string[]; providerHintIds: string[] } {
  const hints = [...deterministic];
  const providerHintIds: string[] = [];
  for (const hint of provider) {
    if (
      providerHintIds.length >= MAX_PROVIDER_HINTS ||
      hints.length >= MAX_TOTAL_HINTS
    )
      break;
    if (hints.includes(hint.text)) continue;
    hints.push(hint.text);
    providerHintIds.push(hint.id);
  }
  return { hints, providerHintIds };
}
