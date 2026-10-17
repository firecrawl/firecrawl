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
 * Both are properties of (endpoint, model) and, for structured output, also of
 * the selected API surface: a model can support `json_schema` over Chat
 * Completions and not over Responses.
 *
 * Structured output has exactly two transports:
 *
 *   strict  provider-native structured output. The schema is provider-side
 *           metadata and never reaches the model as text.
 *   tool   the schema is the parameter definition of a single forced function.
 *           Also provider-side, never prompt text.
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
 *
 * Resolution is per request, not per model handle: plain-text generation must
 * not depend on structured capability at all.
 */

export type ApiMode = "responses" | "chat";
export type StructuredOutputMode = "strict" | "tool";

/** Explicit identity a capability question is asked about. */
export type CapabilityTarget = {
  /** Normalized base URL, e.g. "http://host:11434/v1". */
  baseURL: string;
  /** The model actually requested by this call, never a config default. */
  modelName: string;
};

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
  constructor(
    readonly baseURL: string,
    readonly modelName: string,
  ) {
    super(
      `The configured OpenAI-compatible backend (${baseURL}) supports neither ` +
        "native strict JSON-schema output nor forced tool/function calling " +
        `for model ${modelName}, which structured Firecrawl operations require. ` +
        "Set OPENAI_STRUCTURED_OUTPUT_MODE=strict|tool only if you know the " +
        "backend supports that transport.",
    );
    this.name = "OpenAiNoStructuredTransportError";
  }
}

/**
 * Thrown at request time when tool transport was requested but the backend
 * did not honour it. Returning the ordinary text result instead would let
 * unvalidated model prose stand in for a forced structured call.
 */
export class OpenAiToolTransportViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiToolTransportViolationError";
  }
}

/**
 * True only for the canonical official OpenAI service. This is the single
 * place a URL is inspected, and it distinguishes "is this OpenAI itself" —
 * never "which vendor is behind it".
 */
export function isOfficialOpenAiEndpoint(baseURL?: string): boolean {
  const url = baseURL ?? config.OPENAI_BASE_URL;
  if (!url) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

const PROBE_TIMEOUT_MS = 5000;

export function normalizeBaseUrl(baseURL?: string): string {
  return (
    baseURL ??
    config.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
}

/** Build the capability identity for the model a call actually requested. */
export function capabilityTargetFor(
  modelName: string,
  baseURL?: string,
): CapabilityTarget {
  return { baseURL: normalizeBaseUrl(baseURL), modelName };
}

function authHeaders(baseURL: string): Record<string, string> {
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

const endpointKey = (t: CapabilityTarget) => `${t.baseURL}|${t.modelName}`;

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

async function postProbe(
  target: CapabilityTarget,
  path: string,
  body: unknown,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(`${target.baseURL}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(target.baseURL),
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeResponsesSupport(
  target: CapabilityTarget,
): Promise<ApiMode> {
  let res: Response;
  try {
    res = await postProbe(target, "/responses", {
      model: target.modelName,
      input: "ping",
      max_output_tokens: 1,
    });
  } catch (error) {
    throw new OpenAiCapabilityIndeterminateError(
      `request to ${target.baseURL}/responses failed: ${(error as Error).message}`,
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
 * OpenAI never probes. Concurrent callers share one in-flight probe keyed by
 * the same identity as the cache. Only successful determinations are cached,
 * so a transient 5xx or timeout never becomes a permanent protocol decision.
 */
export async function resolveApiMode(
  target: CapabilityTarget,
): Promise<ApiMode> {
  const configured = config.OPENAI_API_MODE;
  if (configured === "responses" || configured === "chat") return configured;
  if (isOfficialOpenAiEndpoint(target.baseURL)) return "responses";

  const key = endpointKey(target);
  const cached = endpointCache.get(key);
  if (cached) return cached;
  const pending = endpointInFlight.get(key);
  if (pending) return pending;

  const inflight = probeResponsesSupport(target)
    .then(mode => {
      endpointCache.set(key, mode);
      _logger.info(
        mode === "chat"
          ? "OpenAI-compatible endpoint does not implement the Responses API; using Chat Completions"
          : "OpenAI-compatible endpoint implements the Responses API",
        { endpoint: target.baseURL, model: target.modelName },
      );
      return mode;
    })
    .finally(() => endpointInFlight.delete(key));
  endpointInFlight.set(key, inflight);
  return inflight;
}

/** Synchronous view; "unresolved" means nothing has been decided yet. */
export function apiModeSync(target: CapabilityTarget): ApiMode | "unresolved" {
  const configured = config.OPENAI_API_MODE;
  if (configured === "responses" || configured === "chat") return configured;
  if (isOfficialOpenAiEndpoint(target.baseURL)) return "responses";
  return endpointCache.get(endpointKey(target)) ?? "unresolved";
}

// ---------------------------------------------------------------------------
// Structured-output capability
// ---------------------------------------------------------------------------

const structuredCache = new Map<string, StructuredOutputMode>();
const structuredInFlight = new Map<string, Promise<StructuredOutputMode>>();
/**
 * A definitive "this endpoint supports neither transport" is also a stable fact
 * about the endpoint, so it is cached too. Without this, every schema request
 * on such a backend would repeat both probes before failing. Indeterminate and
 * operational failures are still never cached, so a backend that recovers is
 * re-probed.
 */
const noTransportCache = new Set<string>();

/** Structured capability is per (endpoint, model, API surface). */
const structuredKey = (t: CapabilityTarget, apiMode: ApiMode) =>
  `${t.baseURL}|${t.modelName}|${apiMode}`;

const PROBE_TOOL_NAME = "probe";
const PROBE_SCHEMA = {
  type: "object" as const,
  properties: { ok: { type: "boolean" as const, const: true } },
  required: ["ok"] as const,
  additionalProperties: false as const,
};

function jsonSchemaIsAbsent(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  if (status !== 400 && status !== 422) return false;
  // The wording must be about the *capability*, not about a malformed request.
  // "invalid api key" and "unknown model" are operational failures and must
  // never be read as "this backend has no structured output".
  const unsupported =
    /\b(not\s+supported|unsupported|not\s+implemented|not\s+available)\b/i;
  // Chat names response_format/json_schema; Responses names text.format.
  const shape =
    /\b(json_schema|structured[ _]?outputs?|response_format|text\.format)\b/i;
  if (!shape.test(body) || !unsupported.test(body)) return false;
  // "Invalid parameter: response_format/json_schema is not supported" is a
  // capability rejection that happens to use the word "invalid". The generic
  // guard must not veto it, but it must still veto a caller mistake that merely
  // names the field ("Invalid parameter: response_format").
  if (
    /\binvalid\s+parameter\b/i.test(body) &&
    /\bnot\s+supported\b/i.test(body)
  ) {
    return true;
  }
  const callerMistake =
    /\binvalid[ _]?(api[ _]key|model|argument|parameter|request|value|json)\b/i;
  return !callerMistake.test(body);
}

function toolsAreAbsent(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  if (status !== 400 && status !== 422) return false;
  // The wording must be about the capability, not a malformed call:
  // "invalid tool name" and "invalid function arguments" are caller mistakes
  // and must not read as "this backend has no tools".
  return (
    /\b(tools?|function[ _-]?calling)\b[^.]{0,40}?\b(not\s+supported|unsupported|not\s+implemented|not\s+available|disabled|unrecognized|not\s+enabled)\b/i.test(
      body,
    ) ||
    /\b(not\s+supported|unsupported|not\s+implemented)\b[^.]{0,40}?\b(tools?|function[ _-]?calling)\b/i.test(
      body,
    )
  );
}

/** Does the body demonstrate that the strict schema was actually honoured? */
function strictProbeSatisfied(body: any, apiMode: ApiMode): boolean {
  const text =
    apiMode === "responses"
      ? (body?.output?.[0]?.content?.map((c: any) => c?.text).join("") ??
        body?.output_text)
      : body?.choices?.[0]?.message?.content;
  if (typeof text !== "string") return false;
  try {
    const parsed = JSON.parse(text);
    return parsed?.ok === true;
  } catch {
    return false;
  }
}

/** Does the body demonstrate that the forced probe tool was actually called? */
function toolProbeSatisfied(body: any, apiMode: ApiMode): boolean {
  const calls =
    apiMode === "responses"
      ? (body?.output ?? [])
          .filter((o: any) => o?.type === "function_call")
          .map((o: any) => ({ name: o?.name, arguments: o?.arguments }))
      : (body?.choices?.[0]?.message?.tool_calls ?? []).map((c: any) => ({
          name: c?.function?.name,
          arguments: c?.function?.arguments,
        }));
  if (!calls.length) return false;
  // Exactly one call, and it must be the probe tool with a conforming payload.
  if (calls.length !== 1) return false;
  if (calls[0].name !== PROBE_TOOL_NAME) return false;
  try {
    const args =
      typeof calls[0].arguments === "string"
        ? JSON.parse(calls[0].arguments)
        : calls[0].arguments;
    return args?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Probe strict structured output on the SELECTED surface, using that surface's
 * real request shape, and verify the answer before caching.
 */
async function probeJsonSchemaStrict(
  target: CapabilityTarget,
  apiMode: ApiMode,
): Promise<"strict" | "unsupported" | "indeterminate"> {
  const request =
    apiMode === "responses"
      ? {
          model: target.modelName,
          input: "Reply with JSON.",
          max_output_tokens: 32,
          text: {
            format: {
              type: "json_schema",
              name: PROBE_TOOL_NAME,
              strict: true,
              schema: PROBE_SCHEMA,
            },
          },
        }
      : {
          model: target.modelName,
          messages: [{ role: "user", content: "Reply with JSON." }],
          max_tokens: 32,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: PROBE_TOOL_NAME,
              strict: true,
              schema: PROBE_SCHEMA,
            },
          },
        };

  let res: Response;
  try {
    res = await postProbe(
      target,
      `/${apiMode === "responses" ? "responses" : "chat/completions"}`,
      request,
    );
  } catch (error) {
    throw new OpenAiCapabilityIndeterminateError(
      `json_schema probe failed: ${(error as Error).message}`,
    );
  }
  if (res.ok) {
    // 2xx alone is not proof: the backend may have ignored the format.
    const body = await res.json().catch(() => null);
    if (strictProbeSatisfied(body, apiMode)) return "strict";
    throw new OpenAiCapabilityIndeterminateError(
      "the backend accepted the strict structured-output request but did not return a conforming result, so support cannot be confirmed",
      res.status,
    );
  }
  const text = await res.text().catch(() => "");
  if (jsonSchemaIsAbsent(res.status, text)) return "unsupported";
  throw new OpenAiCapabilityIndeterminateError(
    "the structured-output probe was rejected for a reason that does not identify missing json_schema support",
    res.status,
  );
}

async function probeToolsSupported(
  target: CapabilityTarget,
  apiMode: ApiMode,
): Promise<"tool" | "unsupported" | "indeterminate"> {
  const request =
    apiMode === "responses"
      ? {
          model: target.modelName,
          input: "Call the probe tool.",
          max_output_tokens: 32,
          tools: [
            {
              type: "function",
              name: PROBE_TOOL_NAME,
              description: "Probe tool.",
              parameters: PROBE_SCHEMA,
            },
          ],
          tool_choice: { type: "function", name: PROBE_TOOL_NAME },
        }
      : {
          model: target.modelName,
          messages: [{ role: "user", content: "Call the probe tool." }],
          max_tokens: 32,
          tools: [
            {
              type: "function",
              function: {
                name: PROBE_TOOL_NAME,
                description: "Probe tool.",
                parameters: PROBE_SCHEMA,
              },
            },
          ],
          tool_choice: {
            type: "function",
            function: { name: PROBE_TOOL_NAME },
          },
        };

  let res: Response;
  try {
    res = await postProbe(
      target,
      `/${apiMode === "responses" ? "responses" : "chat/completions"}`,
      request,
    );
  } catch (error) {
    throw new OpenAiCapabilityIndeterminateError(
      `tool-calling probe failed: ${(error as Error).message}`,
    );
  }
  if (res.ok) {
    const body = await res.json().catch(() => null);
    if (toolProbeSatisfied(body, apiMode)) return "tool";
    throw new OpenAiCapabilityIndeterminateError(
      "the backend accepted the forced tool request but did not call the probe tool, so tool support cannot be confirmed",
      res.status,
    );
  }
  const text = await res.text().catch(() => "");
  if (toolsAreAbsent(res.status, text)) return "unsupported";
  throw new OpenAiCapabilityIndeterminateError(
    "the tool-calling probe was rejected for a reason that does not identify missing tool support",
    res.status,
  );
}

async function resolveStructuredForTarget(
  target: CapabilityTarget,
  apiMode: ApiMode,
): Promise<StructuredOutputMode> {
  const strict = await probeJsonSchemaStrict(target, apiMode);
  if (strict === "strict") return "strict";

  const tool = await probeToolsSupported(target, apiMode);
  if (tool === "tool") return "tool";
  throw new OpenAiNoStructuredTransportError(target.baseURL, target.modelName);
}

/**
 * Resolve the structured-output transport for THIS model on THIS API surface.
 *
 * Official OpenAI is strict with no probe. Explicit config never probes and
 * never falls back. Concurrent callers share one resolution per
 * (endpoint, model, surface). Resolution happens on first structured use,
 * never at boot.
 */
export async function resolveStructuredOutputMode(
  target: CapabilityTarget,
  apiMode: ApiMode,
): Promise<StructuredOutputMode> {
  const configured = config.OPENAI_STRUCTURED_OUTPUT_MODE;
  if (configured === "strict" || configured === "tool") return configured;
  if (isOfficialOpenAiEndpoint(target.baseURL)) return "strict";

  const key = structuredKey(target, apiMode);
  if (noTransportCache.has(key)) {
    throw new OpenAiNoStructuredTransportError(
      target.baseURL,
      target.modelName,
    );
  }
  const cached = structuredCache.get(key);
  if (cached) return cached;
  const pending = structuredInFlight.get(key);
  if (pending) return pending;

  const inflight = resolveStructuredForTarget(target, apiMode)
    .catch(error => {
      if (error instanceof OpenAiNoStructuredTransportError) {
        noTransportCache.add(key);
      }
      throw error;
    })
    .then(mode => {
      structuredCache.set(key, mode);
      if (mode === "tool") {
        _logger.info("using tool/function transport for structured output", {
          endpoint: target.baseURL,
          model: target.modelName,
          apiMode,
        });
      }
      return mode;
    })
    .finally(() => structuredInFlight.delete(key));
  structuredInFlight.set(key, inflight);
  return inflight;
}

export function structuredOutputModeSync(
  target: CapabilityTarget,
  apiMode: ApiMode,
): StructuredOutputMode | "unresolved" {
  const configured = config.OPENAI_STRUCTURED_OUTPUT_MODE;
  if (configured === "strict" || configured === "tool") return configured;
  if (isOfficialOpenAiEndpoint(target.baseURL)) return "strict";
  return structuredCache.get(structuredKey(target, apiMode)) ?? "unresolved";
}

/** Test seams for the capability classifiers. */
export const jsonSchemaIsAbsentForTest = jsonSchemaIsAbsent;
export const toolsAreAbsentForTest = toolsAreAbsent;

/** Test seam. */
export function __resetCapabilityCaches() {
  endpointCache.clear();
  endpointInFlight.clear();
  structuredCache.clear();
  structuredInFlight.clear();
  noTransportCache.clear();
}

/** Test seam: inspect cache state for key-isolation assertions. */
export const __caches = {
  endpoint: endpointCache,
  structured: structuredCache,
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

type Prompt = LanguageModelV3CallOptions["prompt"];

const STRUCTURED_TOOL_NAME = "firecrawl_structured_output";

/** Does this call actually ask for schema-backed structured output? */
export function requestWantsStructuredOutput(
  params: Pick<LanguageModelV3CallOptions, "responseFormat">,
): boolean {
  const rf = params?.responseFormat;
  return !!rf && rf.type === "json" && rf.schema != null;
}

/**
 * Force a single tool whose parameter schema is the call's schema, then hand
 * the returned arguments back to the SDK as text so the caller's own output
 * strategy still parses and validates them.
 *
 * Three details matter and were verified against the SDK source:
 *
 *   - `responseFormat` must be rewritten to `{type:"text"}`, otherwise the
 *     provider emits a strict structured-output request, which is exactly the
 *     capability we are working around. Parsing is unaffected: generateObject
 *     validates from its own output strategy, not from this field.
 *   - a tool-call part's `input` arrives as a string on this SDK version and
 *     must be passed through verbatim. Re-serializing it yields a
 *     double-encoded string and corrupts the parsed object.
 *   - a missing or wrong tool call is a hard failure, never a passthrough.
 *     Returning the ordinary text result would let unvalidated prose stand in
 *     for a forced structured call.
 *
 * Annotations are forwarded intact: measurements showed stripping them makes
 * weaker models abandon the schema entirely and echo their input.
 */
// SCOPE: this middleware implements the non-streaming path only.
//
// Firecrawl performs every structured generation through `generateObject`
// (llmExtract, llmExtract-f0, branding, engpicker, promptInjectionGuard).
// `streamText`/`streamObject` are re-exported by the LangSmith shim but never
// called, and no `getModel()` caller uses a streaming API, so no schema-backed
// request reaches `doStream` today.
//
// If a structured streaming call site is ever added, this middleware must also
// implement `wrapStream`: streamed tool-call deltas have to be reassembled into
// complete arguments and validated against the caller's schema, and a stream
// with no forced tool call must fail closed exactly as `wrapGenerate` does.
// Silently returning the stream would let unvalidated model text stand in for a
// forced structured call.
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
        // that makes the provider build a strict structured-output request,
        // which is the exact capability this transport exists to avoid.
        // Removing it would silently reintroduce the failure this whole mode
        // works around, and it would only show up as a 400 on backends that
        // lack strict structured output.
        //
        // Parsing is unaffected. generateObject validates from its own output
        // strategy (the schema passed to the call), not from this field.
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
      const toolCalls = result.content.filter(
        part => part.type === "tool-call",
      );
      const named = toolCalls.filter(
        (part: any) => part.toolName === STRUCTURED_TOOL_NAME,
      );
      if (named.length === 0) {
        throw new OpenAiToolTransportViolationError(
          "tool transport was requested but the model did not call " +
            `${STRUCTURED_TOOL_NAME}. The backend may not honour forced tool ` +
            "selection; refusing to fall back to unvalidated text output.",
        );
      }
      if (named.length > 1) {
        throw new OpenAiToolTransportViolationError(
          `tool transport expected exactly one ${STRUCTURED_TOOL_NAME} call but received ${named.length}`,
        );
      }
      const toolCall = named[0] as any;
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
 * `strict` (and official OpenAI) returns the model untouched, so default
 * behaviour is byte-identical to main. `tool` installs the forced tool
 * transport.
 */
export function applyStructuredOutputPolicy<
  M extends Parameters<typeof wrapLanguageModel>[0]["model"],
>(model: M, mode: StructuredOutputMode): M {
  if (mode !== "tool") return model;
  return wrapLanguageModel({
    model,
    middleware: toolTransportMiddleware(),
  }) as M;
}
