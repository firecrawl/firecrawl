import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { config } from "../config";
import { logger as _logger } from "./logger";

/**
 * Endpoint and structured-output compatibility for the OpenAI provider.
 *
 * The OpenAI provider serves two very different deployments here: official
 * OpenAI, and self-hosted backends reached through `OPENAI_BASE_URL`. Two
 * independent capabilities matter, and neither is inferred from the other:
 *
 *   1. which HTTP endpoint exists (`/responses` vs `/chat/completions`)
 *   2. how a schema can be conveyed to the model
 *
 * Structured output has exactly three transports:
 *
 *   strict  provider-native `response_format: json_schema`. The schema is
 *           provider-side metadata and never reaches the model as text.
 *   tool   the schema is carried as the parameter definition of a single
 *           forced function. Also provider-side, never prompt text.
 *
 * There is deliberately no automatic prompt-carried fallback. Carrying a
 * caller-supplied schema in prompt content moves caller-controlled strings
 * (`description`, `title`, `$comment`, examples, defaults, property names)
 * into a position the model reads as instructions. Measured on one local
 * backend (Ollama 0.32.13, llama3-groq-tool-use) against ten adversarial
 * schema cases, prompt transport accepted injected values in 2/10 while the
 * strict and tool transports accepted 0/10.
 *
 * That is evidence of resistance for that backend and those cases, not a
 * guarantee: no transport is immune to prompt injection, and the tool path
 * still relies on the caller's schema for local validation. When neither
 * provider-side transport is available we fail closed rather than silently
 * weakening the schema trust boundary.
 */

export type ApiMode = "responses" | "chat";
export type StructuredOutputMode = "strict" | "tool";

/** Thrown when capability could not be determined, or no safe transport exists. */
export class OpenAiCapabilityIndeterminateError extends Error {
  constructor(
    readonly reason: string,
    readonly status?: number,
  ) {
    super(
      `Could not determine OpenAI-compatible capabilities: ${reason}` +
        (status ? ` (HTTP ${status})` : ""),
    );
    this.name = "OpenAiCapabilityIndeterminateError";
  }
}

/**
 * Thrown when the backend supports neither transport automatic mode may use.
 * Deliberately actionable and never a silent downgrade.
 */
export class OpenAiNoStructuredTransportError extends Error {
  constructor(baseURL: string) {
    super(
      `The configured OpenAI-compatible backend (${baseURL}) supports neither ` +
        "native strict JSON-schema output nor forced tool/function calling, " +
        "which structured Firecrawl operations require. " +
        "Set OPENAI_STRUCTURED_OUTPUT_MODE=strict|tool only if you know the " +
        "backend supports that transport.",
    );
    this.name = "OpenAiNoStructuredTransportError";
  }
}

/**
 * True only for the canonical official OpenAI service. This is the single
 * place a URL is inspected, and it distinguishes "is this OpenAI itself" —
 * never "which vendor is behind it".
 */
export function isOfficialOpenAiEndpoint(): boolean {
  const baseURL = config.OPENAI_BASE_URL;
  if (!baseURL) return true;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

const PROBE_TIMEOUT_MS = 5000;

function normalizedBaseUrl(): string {
  return (config.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
}

function probeModel(): string {
  return config.MODEL_NAME ?? "gpt-4o-mini";
}

function isCustomEndpoint(): boolean {
  return !isOfficialOpenAiEndpoint();
}

function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(config.OPENAI_API_KEY
      ? { authorization: `Bearer ${config.OPENAI_API_KEY}` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Endpoint capability
// ---------------------------------------------------------------------------

const endpointCache = new Map<string, ApiMode>();
const endpointInFlight = new Map<string, Promise<ApiMode>>();

/**
 * Only these responses prove the Responses endpoint is absent. Everything else
 * (auth, rate limit, validation, 5xx, timeout, connection error, TLS) is an
 * operational failure and must not change the protocol: switching on a
 * transient error would strand a self-hoster on the weaker protocol.
 */
function responsesIsAbsent(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  return (
    status === 400 &&
    /\b(unknown|unrecognized|not\s+(found|implemented|supported)|no such)\b[\s\S]{0,60}\b(endpoint|route|path|api)\b/i.test(
      body,
    )
  );
}

async function postProbe(path: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(`${normalizedBaseUrl()}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeResponsesSupport(): Promise<ApiMode> {
  let res: Response;
  try {
    res = await postProbe("/responses", {
      model: probeModel(),
      input: "ping",
      max_output_tokens: 1,
    });
  } catch (error) {
    throw new OpenAiCapabilityIndeterminateError(
      `request to ${normalizedBaseUrl()}/responses failed: ${(error as Error).message}`,
    );
  }
  if (res.ok) return "responses";
  const body = await res.text().catch(() => "");
  if (responsesIsAbsent(res.status, body)) return "chat";
  throw new OpenAiCapabilityIndeterminateError(
    "the Responses endpoint returned an operational error, not an unsupported-route error",
    res.status,
  );
}

/**
 * Resolve which API surface to use. Explicit config never probes. Official
 * OpenAI never probes. Concurrent callers share one in-flight probe per
 * (endpoint, model) pair. Only successful determinations are cached, so a
 * transient 5xx or timeout never becomes a permanent protocol decision.
 */
export async function resolveApiMode(modelName?: string): Promise<ApiMode> {
  const configured = config.OPENAI_API_MODE;
  if (configured === "responses" || configured === "chat") return configured;
  if (!isCustomEndpoint()) return "responses";

  const key = `${normalizedBaseUrl()}|${modelName ?? probeModel()}`;
  const cached = endpointCache.get(key);
  if (cached) return cached;
  const pending = endpointInFlight.get(key);
  if (pending) return pending;

  const inflight = probeResponsesSupport()
    .then(mode => {
      endpointCache.set(key, mode);
      _logger.info(
        mode === "chat"
          ? "OpenAI-compatible endpoint does not implement the Responses API; using Chat Completions"
          : "OpenAI-compatible endpoint implements the Responses API",
        { endpoint: normalizedBaseUrl() },
      );
      return mode;
    })
    .finally(() => endpointInFlight.delete(key));
  endpointInFlight.set(key, inflight);
  return inflight;
}

/** Sync view for request shaping; "unresolved" means nothing decided yet. */
export function apiModeSync(): ApiMode | "unresolved" {
  const configured = config.OPENAI_API_MODE;
  if (configured === "responses" || configured === "chat") return configured;
  if (!isCustomEndpoint()) return "responses";
  return (
    endpointCache.get(`${normalizedBaseUrl()}|${probeModel()}`) ?? "unresolved"
  );
}

// ---------------------------------------------------------------------------
// Structured-output capability
// ---------------------------------------------------------------------------

/**
 * Both probes share one cache: a capability answer is cached, and only when the
 * backend positively demonstrated the capability or positively rejected it.
 */
const structuredCache = new Map<string, StructuredOutputMode>();
const structuredInFlight = new Map<string, Promise<StructuredOutputMode>>();

function jsonSchemaIsAbsent(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  return (
    (status === 400 || status === 422) &&
    /\b(json_schema|structured output|structured_outputs|response_format)\b/i.test(
      body,
    ) &&
    /\b(not\s+supported|unsupported|not\s+implemented|unknown|unrecognized|invalid)\b/i.test(
      body,
    )
  );
}

function toolsAreAbsent(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  return (
    (status === 400 || status === 422) &&
    /\b(tool|function)[_ ]?(calling|call|use|support)?\b/i.test(body) &&
    /\b(not\s+supported|unsupported|not\s+implemented|unknown|unrecognized|invalid|disabled)\b/i.test(
      body,
    )
  );
}

async function probeJsonSchema(): Promise<StructuredOutputMode> {
  let res: Response;
  try {
    res = await postProbe("/chat/completions", {
      model: probeModel(),
      messages: [{ role: "user", content: "Reply with JSON." }],
      max_tokens: 8,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "probe",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    });
  } catch (error) {
    throw new OpenAiCapabilityIndeterminateError(
      `json_schema probe failed: ${(error as Error).message}`,
    );
  }
  if (res.ok) return "strict";
  const body = await res.text().catch(() => "");
  if (jsonSchemaIsAbsent(res.status, body)) {
    _logger.info(
      "endpoint rejects json_schema; falling back to tool/function transport",
      { endpoint: normalizedBaseUrl() },
    );
    return probeTools();
  }
  // Ambiguous: surface it rather than downgrading.
  throw new OpenAiCapabilityIndeterminateError(
    "the structured-output probe was rejected for a reason that does not identify missing json_schema support",
    res.status,
  );
}

async function probeTools(): Promise<StructuredOutputMode> {
  let res: Response;
  try {
    res = await postProbe("/chat/completions", {
      model: probeModel(),
      messages: [{ role: "user", content: "Reply with the tool." }],
      max_tokens: 8,
      tools: [
        {
          type: "function",
          function: {
            name: "probe",
            description: "Probe tool.",
            parameters: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "probe" } },
    });
  } catch (error) {
    throw new OpenAiCapabilityIndeterminateError(
      `tool-calling probe failed: ${(error as Error).message}`,
    );
  }
  if (res.ok) return "tool";
  const body = await res.text().catch(() => "");
  if (toolsAreAbsent(res.status, body)) {
    throw new OpenAiNoStructuredTransportError(normalizedBaseUrl());
  }
  throw new OpenAiCapabilityIndeterminateError(
    "the tool-calling probe was rejected for a reason that does not identify missing tool support",
    res.status,
  );
}

/**
 * Resolve the structured-output transport.
 *
 * Official OpenAI is strict with no probe. Explicit config never probes and
 * never falls back. Concurrent callers share one resolution per
 * (endpoint, model). Resolution happens on first use, never at boot, so a
 * missing or broken backend cannot stop unrelated scrape paths from starting.
 */
export async function resolveStructuredOutputMode(
  modelName?: string,
): Promise<StructuredOutputMode> {
  const configured = config.OPENAI_STRUCTURED_OUTPUT_MODE;
  if (configured === "strict" || configured === "tool") return configured;
  if (!isCustomEndpoint()) return "strict";

  const key = `${normalizedBaseUrl()}|${modelName ?? probeModel()}`;
  const cached = structuredCache.get(key);
  if (cached) return cached;
  const pending = structuredInFlight.get(key);
  if (pending) return pending;

  const inflight = probeJsonSchema()
    .then(mode => {
      structuredCache.set(key, mode);
      return mode;
    })
    .finally(() => structuredInFlight.delete(key));
  structuredInFlight.set(key, inflight);
  return inflight;
}

export function structuredOutputModeSync():
  | StructuredOutputMode
  | "unresolved" {
  const configured = config.OPENAI_STRUCTURED_OUTPUT_MODE;
  if (configured === "strict" || configured === "tool") return configured;
  if (!isCustomEndpoint()) return "strict";
  return (
    structuredCache.get(`${normalizedBaseUrl()}|${probeModel()}`) ??
    "unresolved"
  );
}

/** Test seam. */
export function __resetCapabilityCaches() {
  endpointCache.clear();
  endpointInFlight.clear();
  structuredCache.clear();
  structuredInFlight.clear();
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

type Prompt = LanguageModelV3CallOptions["prompt"];

const STRUCTURED_TOOL_NAME = "firecrawl_structured_output";

/**
 * Force a single tool whose parameter schema is the call's schema, then hand
 * the returned arguments back to the SDK as text so the caller's own output
 * strategy still parses and validates them.
 *
 * Two details matter and were verified against the SDK source:
 *
 *   - `responseFormat` must be rewritten to `{type:"text"}`, otherwise the
 *     provider emits `response_format: json_schema`, which is exactly the
 *     capability we are working around. Parsing is unaffected: generateObject
 *     validates from its own output strategy, not from this field.
 *   - a tool-call part's `input` arrives as a string on this SDK version and
 *     must be passed through verbatim. Re-serializing it yields a
 *     double-encoded string and corrupts the parsed object.
 *
 * Annotations are forwarded intact: measurements showed stripping them makes
 * weaker models abandon the schema entirely and echo their input.
 */
function toolTransportMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      const rf = params.responseFormat;
      if (!rf || rf.type !== "json" || !rf.schema) return params;

      return {
        ...params,
        // Intentionally rewrite responseFormat to text.
        //
        // Do NOT "simplify" this by keeping the original json responseFormat:
        // that makes the provider build `response_format: json_schema`, which
        // is the exact capability this transport exists to avoid. Removing it
        // would silently reintroduce the failure this whole mode works around,
        // and it would only show up as a 400 on backends that lack json_schema.
        //
        // Parsing is unaffected. generateObject validates from its own output
        // strategy (the schema passed to the call), not from this field, so the
        // arguments we substitute into `content` below are still parsed and
        // validated against the caller's original schema.
        responseFormat: { type: "text" },
        tools: [
          {
            type: "function",
            name: STRUCTURED_TOOL_NAME,
            description:
              "Return the structured result. Call this exactly once with the extracted fields.",
            inputSchema: rf.schema,
          },
        ],
        toolChoice: { type: "tool", toolName: STRUCTURED_TOOL_NAME },
      } as typeof params;
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      const toolCall = result.content.find(part => part.type === "tool-call");
      if (!toolCall) return result;
      const text =
        typeof toolCall.input === "string"
          ? toolCall.input
          : JSON.stringify(toolCall.input);
      return {
        ...result,
        content: [{ type: "text", text } as never],
        finishReason: { unified: "stop", raw: "stop" } as never,
      };
    },
  };
}

/**
 * Apply the resolved transport to a model.
 *
 * `strict` (and unresolved, and official OpenAI) returns the model untouched,
 * so default behaviour is byte-identical to main. `tool` installs the forced
 * tool transport.
 */
export function applyStructuredOutputPolicy<
  M extends Parameters<typeof wrapLanguageModel>[0]["model"],
>(
  model: M,
  mode: StructuredOutputMode = structuredOutputModeSync() as StructuredOutputMode,
): M {
  if (mode !== "tool") return model;
  return wrapLanguageModel({
    model,
    middleware: toolTransportMiddleware(),
  }) as M;
}
