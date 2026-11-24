import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import { config } from "../../../config";
import { service } from "../../../service";
import { getModel } from "../../generic-ai";
import { CostTracking } from "../../cost-tracking";
import {
  ANCHOR_MODEL,
  ANCHOR_PICKER_MAX_TOKENS,
  ASK_LLM_MAX_CALLS,
  ASK_LLM_MAX_TOKENS,
  CODEGEN_MAX_TOKENS,
  CODEGEN_MODEL,
  LIGHT_MODEL,
} from "../config";
import { type CacheBackend } from "../core/cache";
import { modelPrices } from "../../model-prices";
import { ASK_LLM_SYSTEM, type ChatMessage } from "./prompts";
import { errorMessage, log, sha } from "../core/util";

function record(
  costTracking: CostTracking,
  role: string,
  provider: string,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): void {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const key = `${provider}/${model}`;
  const price = (
    modelPrices as Record<
      string,
      { input_cost_per_token?: number; output_cost_per_token?: number }
    >
  )[key];
  if (!price) log(`no pricing for ${key}`);
  const cost =
    input * (price?.input_cost_per_token ?? 0) +
    output * (price?.output_cost_per_token ?? 0);
  costTracking.addCall({
    type: "other",
    model: key,
    cost,
    tokens: { input, output },
    metadata: { module: "deterministic-json", role },
  });
}

interface Generation {
  content: string;
  truncated: boolean;
}

// The AI SDK takes system text as `instructions`, not as a message.
function splitInstructions(messages: ChatMessage[]) {
  return {
    instructions: messages
      .filter(message => message.role === "system")
      .map(message => message.content)
      .join("\n\n"),
    messages: messages
      .filter(message => message.role === "user")
      .map(message => ({ role: "user" as const, content: message.content })),
  };
}

const FALLBACK_MODEL = "gpt-4o-mini";

function resolveDeterministicModel(
  preferredModel: string,
  preferredProvider: string,
) {
  if (service.llmProviders.get(preferredProvider)?.enabled()) {
    return {
      provider: preferredProvider,
      modelName: preferredModel,
      model: getModel(preferredModel, preferredProvider),
    };
  }
  const provider = service.llmProviders.get("ollama")?.enabled()
    ? "ollama"
    : "openai";
  const modelName = config.MODEL_NAME || FALLBACK_MODEL;
  return {
    provider,
    modelName,
    model: getModel(modelName, provider),
  };
}

export async function generateCode(
  messages: ChatMessage[],
  costTracking: CostTracking,
): Promise<Generation> {
  let res;
  let resolved: ReturnType<typeof resolveDeterministicModel>;
  try {
    resolved = resolveDeterministicModel(CODEGEN_MODEL, "vertex");
    res = await generateText({
      model: resolved.model,
      ...splitInstructions(messages),
      temperature: 1.0, // even though it would be nice to have more deterministic output, google recommends keeping this at 1 for complex tasks
      maxOutputTokens: CODEGEN_MAX_TOKENS,
    });
  } catch (err) {
    throw new Error(`codegen API call failed: ${errorMessage(err)}`);
  }
  record(
    costTracking,
    "codegen",
    resolved.provider,
    resolved.modelName,
    res.usage,
  );
  return { content: res.text ?? "", truncated: res.finishReason === "length" };
}

export async function pickSnippets(
  messages: ChatMessage[],
  costTracking: CostTracking,
): Promise<string[]> {
  let res;
  let resolved: ReturnType<typeof resolveDeterministicModel>;
  try {
    resolved = resolveDeterministicModel(ANCHOR_MODEL, "groq");
    res = await generateText({
      model: resolved.model,
      ...splitInstructions(messages),
      temperature: 0,
      maxOutputTokens: ANCHOR_PICKER_MAX_TOKENS,
    });
  } catch (err) {
    throw new Error(`anchor-picker API call failed: ${errorMessage(err)}`);
  }
  record(
    costTracking,
    "anchor",
    resolved.provider,
    resolved.modelName,
    res.usage,
  );
  return parseSnippets(res.text?.trim() ?? "");
}

function parseSnippets(raw: string): string[] {
  const trimmed = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(jsonrepair(trimmed));
  } catch {
    return [];
  }
  const list = Array.isArray(value)
    ? value
    : ((value as { snippets?: unknown })?.snippets ?? []);
  return Array.isArray(list)
    ? list.filter((s): s is string => typeof s === "string")
    : [];
}

export type AskLlm = (prompt: string, schema?: unknown) => Promise<unknown>;

const ASK_LLM_RETRIES = 3;

function normalizePlainText(s: string): string {
  return /^(null|none|n\/a|undefined)$/i.test(s.trim()) ? "" : s;
}

function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(jsonrepair(raw));
  }
}

// askLlm function for one extraction run: caches responses, dedupes identical
// in-flight calls, caps real API calls at maxCalls. Any failure resolves to null
// so one bad inner call can't sink the whole extraction.
export function makeAskLlm(
  cache: CacheBackend,
  costTracking: CostTracking,
  maxCalls = ASK_LLM_MAX_CALLS,
): AskLlm {
  let apiCalls = 0;
  const inFlight = new Map<string, Promise<unknown>>();

  const ask = (prompt: string, schema?: unknown): Promise<unknown> => {
    const key =
      schema == null ? prompt : `${prompt}\0${JSON.stringify(schema)}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = askOnce(prompt, schema).catch(err => {
      log(`askLlm failed, returning null: ${errorMessage(err)}`);
      return null;
    });
    inFlight.set(key, pending);
    return pending;
  };

  async function askOnce(prompt: string, schema: unknown): Promise<unknown> {
    const structured = schema != null;
    if (structured && (typeof schema !== "object" || Array.isArray(schema))) {
      throw new Error("askLlm schema must be a JSON Schema object");
    }

    const objectSchema =
      structured && (schema as { type?: unknown }).type === "object";
    const wrap = structured && !objectSchema;

    const userContent = !structured
      ? prompt
      : wrap
        ? `${prompt}\n\nReturn ONLY a JSON object {"value": V} where V matches this JSON Schema (use null if unknown):\n\n${JSON.stringify(schema)}`
        : `${prompt}\n\n### JSON Schema (match this shape; use null for unknown)\n\n${JSON.stringify(schema)}`;

    const finalize = (raw: string): unknown => {
      const parsed = parseJsonLoose(raw);
      let value: unknown = parsed;
      if (
        wrap &&
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "value" in parsed
      ) {
        value = (parsed as Record<string, unknown>).value;
      }
      return typeof value === "string" ? normalizePlainText(value) : value;
    };

    const resolvedProvider = service.llmProviders.get("groq")?.enabled()
      ? "groq"
      : service.llmProviders.get("ollama")?.enabled()
        ? "ollama"
        : "openai";
    const resolvedModelName =
      resolvedProvider === "groq"
        ? LIGHT_MODEL
        : config.MODEL_NAME || FALLBACK_MODEL;
    const cacheKey = sha(
      `${resolvedProvider}\0${resolvedModelName}\0${ASK_LLM_SYSTEM}\0${userContent}\0${structured ? "json" : "text"}`,
    );
    const cached = await cache.getLlm(cacheKey);
    if (cached) {
      try {
        const value = structured
          ? finalize(cached.response)
          : normalizePlainText(cached.response);
        await cache.touch?.(cacheKey);
        return value;
      } catch (err) {
        // Fall through to a fresh call; otherwise the parse error sinks the
        // whole ask to null via ask()'s catch.
        log(
          `ignoring unparseable cached askLlm response: ${errorMessage(err)}`,
        );
      }
    }

    let lastError = "";
    for (let attempt = 1; attempt <= ASK_LLM_RETRIES; attempt++) {
      if (apiCalls >= maxCalls)
        throw new Error(`askLlm call budget exhausted (${maxCalls})`);
      apiCalls++;

      let raw = "";
      try {
        const resolved = resolveDeterministicModel(LIGHT_MODEL, "groq");
        const res = await generateText({
          model: resolved.model,
          temperature: 0,
          maxOutputTokens: ASK_LLM_MAX_TOKENS,
          instructions: ASK_LLM_SYSTEM,
          messages: [{ role: "user", content: userContent }],
        });
        raw = res.text?.trim() ?? "";
        record(
          costTracking,
          "askLlm",
          resolved.provider,
          resolved.modelName,
          res.usage,
        );
      } catch (err) {
        lastError = errorMessage(err);
        continue;
      }
      if (!raw) {
        // For the text path an empty reply is the intended "absent" answer
        // (ASK_LLM_SYSTEM tells the model to return an empty string), so honor
        // it instead of retrying to a null. Structured calls still need
        // parseable JSON, so an empty body there remains a retryable failure.
        if (!structured) {
          await cache.setLlm(cacheKey, "");
          return "";
        }
        lastError = "empty response";
        continue;
      }

      let value: unknown;
      try {
        value = structured ? finalize(raw) : normalizePlainText(raw);
      } catch (err) {
        lastError = `parse: ${errorMessage(err)}`;
        continue;
      }

      await cache.setLlm(cacheKey, raw);
      return value;
    }

    throw new Error(
      `askLlm failed after ${ASK_LLM_RETRIES} attempts: ${lastError}`,
    );
  }

  return ask;
}
