import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config";
import { createOllama } from "ollama-ai-provider-v2";
import { anthropic } from "@ai-sdk/anthropic";
import { groq } from "@ai-sdk/groq";
import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fireworks } from "@ai-sdk/fireworks";
import { deepinfra } from "@ai-sdk/deepinfra";
import { createVertex } from "@ai-sdk/google-vertex";
import { withUsageTelemetry } from "./ai-usage-telemetry";
import {
  applyStructuredOutputPolicy,
  OpenAiToolTransportViolationError,
  capabilityTargetFor,
  requestWantsStructuredOutput,
  resolveApiMode,
  resolveStructuredOutputMode,
  type ApiMode,
} from "./openai-structured-output";

type Provider =
  | "openai"
  | "ollama"
  | "anthropic"
  | "groq"
  | "google"
  | "openrouter"
  | "fireworks"
  | "deepinfra"
  | "vertex";
const defaultProvider: Provider = config.OLLAMA_BASE_URL ? "ollama" : "openai";

const providerList: Record<Provider, any> = {
  openai: createOpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.OPENAI_BASE_URL,
  }), //OPENAI_API_KEY
  ollama: createOllama({
    baseURL: config.OLLAMA_BASE_URL,
  }),
  anthropic, //ANTHROPIC_API_KEY
  groq, //GROQ_API_KEY
  google, //GOOGLE_GENERATIVE_AI_API_KEY
  openrouter: createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
  }),
  fireworks, //FIREWORKS_API_KEY
  deepinfra, //DEEPINFRA_API_KEY
  vertex: createVertex({
    project: "firecrawl",
    //https://github.com/vercel/ai/issues/6644 bug
    baseURL:
      "https://aiplatform.googleapis.com/v1/projects/firecrawl/locations/global/publishers/google",
    location: "global",
    googleAuthOptions: config.VERTEX_CREDENTIALS
      ? {
          credentials: JSON.parse(atob(config.VERTEX_CREDENTIALS)),
        }
      : {
          keyFile: "./gke-key.json",
        },
  }),
};

export function getModel(name: string, provider: Provider = defaultProvider) {
  if (name === "gemini-2.5-pro") {
    name = "gemini-2.5-pro";
  }
  const modelName = config.MODEL_NAME || name;
  if (provider === "openai") {
    // o3-mini returns empty text via the Responses API — force Chat Completions
    // for that model, but still resolve structured capability per request so a
    // custom backend that cannot do strict structured output still works.
    return adaptiveOpenAiModel(
      modelName,
      modelName.startsWith("o3-mini") ? "chat" : undefined,
    );
  }
  // Non-OpenAI providers are untouched by OPENAI_API_MODE and
  // OPENAI_STRUCTURED_OUTPUT_MODE, which are OpenAI-provider settings.
  return withUsageTelemetry(providerList[provider](modelName));
}

/**
 * An OpenAI-provider model handle that resolves capabilities per request.
 *
 * Every request needs an API surface; only schema-backed requests need a
 * structured-output transport. Plain-text generation must not depend on
 * structured capability, so a backend that can do ordinary text but no
 * structured transport still serves non-structured features.
 *
 * Capability resolution is delegated to the resolver-level caches, so this
 * handle keeps no long-lived Promise: a transient probe failure cannot poison
 * the handle, and the next request retries.
 */
function adaptiveOpenAiModel(modelName: string, forcedApiMode?: ApiMode): any {
  const target = capabilityTargetFor(modelName);
  const resolve = async () => {
    const apiMode = forcedApiMode ?? (await resolveApiMode(target));
    const surface = withUsageTelemetry(
      apiMode === "chat"
        ? providerList.openai.chat(modelName)
        : providerList.openai.responses(modelName),
    );
    return { apiMode, surface };
  };

  const run = async (method: "doGenerate" | "doStream", params: unknown) => {
    const { apiMode, surface } = await resolve();
    resolvedApiMode = apiMode;
    const wantsStructured = requestWantsStructuredOutput(
      params as Parameters<typeof requestWantsStructuredOutput>[0],
    );
    if (!wantsStructured) {
      // Ordinary text: no structured capability resolution at all.
      return (surface as any)[method](params);
    }
    if (method === "doStream") {
      // Unreachable today: no Firecrawl call site streams a schema-backed
      // request. Fail loudly rather than send a schema-bearing request down a
      // path with no forced-tool handling, which would let unvalidated model
      // text stand in for a structured result. See toolTransportMiddleware.
      throw new OpenAiToolTransportViolationError(
        "structured streaming is not supported by the OpenAI compatibility " +
          "middleware; use the non-streaming structured generation path",
      );
    }
    // Structured capability is per (endpoint, model, API surface), so it can
    // only be resolved once the surface is known.
    const mode = await resolveStructuredOutputMode(target, apiMode);
    const prepared = applyStructuredOutputPolicy(surface, mode);
    return (prepared as any)[method](params);
  };

  // Resolved API surface, or undefined until the first request. The SDK reads
  // `model.provider` for the `ai.model.provider` telemetry attribute when a call
  // is recorded, so it must reflect the surface actually used rather than a
  // static guess.
  let resolvedApiMode: ApiMode | undefined = forcedApiMode;

  return {
    specificationVersion: "v3",
    get provider() {
      return resolvedApiMode === "chat"
        ? "openai.chat"
        : resolvedApiMode === "responses"
          ? "openai.responses"
          : "openai";
    },
    modelId: modelName,
    doGenerate: async (params: unknown) => {
      const result = await run("doGenerate", params);
      return result;
    },
    doStream: async (params: unknown) => {
      const result = await run("doStream", params);
      return result;
    },
  };
}

export function getEmbeddingModel(
  name: string,
  provider: Provider = defaultProvider,
) {
  return config.MODEL_EMBEDDING_NAME
    ? providerList[provider].embedding(config.MODEL_EMBEDDING_NAME)
    : providerList[provider].embedding(name);
}
