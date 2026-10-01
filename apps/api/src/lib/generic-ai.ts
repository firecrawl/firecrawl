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
  apiModeSync,
  applyStructuredOutputPolicy,
  resolveApiMode,
  resolveStructuredOutputMode,
  structuredOutputModeSync,
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
    // o3-mini returns empty text via the Responses API — force Chat Completions.
    if (modelName.startsWith("o3-mini")) {
      return finish(providerList.openai.chat(modelName), modelName);
    }
    // Endpoint and structured-output capabilities are resolved lazily and
    // memoized: the first applicable request decides, concurrent callers share
    // one resolution, and boot never waits on an LLM backend.
    const mode = apiModeSync();
    if (mode !== "unresolved") {
      return finish(openAiModel(modelName, mode), modelName);
    }
    return lazyOpenAiModel(modelName);
  }
  return finish(providerList[provider](modelName), modelName);
}

function openAiModel(modelName: string, mode: "responses" | "chat") {
  return mode === "chat"
    ? providerList.openai.chat(modelName)
    : providerList.openai.responses(modelName);
}

/**
 * Model handle for a capability that has not been resolved yet. It resolves
 * on first use and then behaves exactly like the eager path, so an official
 * OpenAI deployment (which always resolves to "responses"/"strict"
 * synchronously) never takes this branch.
 */
function lazyOpenAiModel(modelName: string): any {
  let ready: Promise<any> | null = null;
  const ensure = () => {
    if (!ready) {
      ready = (async () => {
        const [apiMode, structured] = await Promise.all([
          resolveApiMode(modelName),
          resolveStructuredOutputMode(modelName),
        ]);
        return finish(openAiModel(modelName, apiMode), modelName, structured);
      })();
    }
    return ready;
  };

  const passthrough =
    (method: string) =>
    async (...args: unknown[]) => {
      const model = await ensure();
      return (model as any)[method](...args);
    };

  return {
    specificationVersion: "v3",
    provider: "openai.unresolved",
    modelId: modelName,
    doGenerate: passthrough("doGenerate"),
    doStream: passthrough("doStream"),
  };
}

/**
 * Telemetry first, then the structured-output policy, so the policy is the
 * outermost wrapper and still sees provider options on the way in.
 */
function finish(
  model: any,
  modelName: string,
  structured?: "strict" | "tool",
): any {
  const telemetry = withUsageTelemetry(model);
  const resolved = structured ?? structuredOutputModeSync();
  return applyStructuredOutputPolicy(
    telemetry,
    resolved === "tool" ? "tool" : "strict",
  );
}

export function getEmbeddingModel(
  name: string,
  provider: Provider = defaultProvider,
) {
  return config.MODEL_EMBEDDING_NAME
    ? providerList[provider].embedding(config.MODEL_EMBEDDING_NAME)
    : providerList[provider].embedding(name);
}
