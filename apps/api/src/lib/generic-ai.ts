import { createOpenAI } from "@ai-sdk/openai";
import { config, type ModelProvider } from "../config";
import { createOllama } from "ollama-ai-provider-v2";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { groq } from "@ai-sdk/groq";
import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fireworks } from "@ai-sdk/fireworks";
import { deepinfra } from "@ai-sdk/deepinfra";
import { createVertex } from "@ai-sdk/google-vertex";
import { getMiniMaxBaseURL } from "./minimax";

const defaultProvider: ModelProvider =
  config.MODEL_PROVIDER ?? (config.OLLAMA_BASE_URL ? "ollama" : "openai");
const defaultEmbeddingProvider: ModelProvider = config.OLLAMA_BASE_URL
  ? "ollama"
  : "openai";

const minimaxOpenAI = createOpenAI({
  apiKey: config.MINIMAX_API_KEY,
  baseURL: getMiniMaxBaseURL(config.MINIMAX_REGION, "openai"),
});
const minimaxAnthropic = createAnthropic({
  apiKey: config.MINIMAX_API_KEY,
  // The Anthropic SDK appends /messages; MiniMax's request route is /v1/messages.
  baseURL: `${getMiniMaxBaseURL(config.MINIMAX_REGION, "anthropic")}/v1`,
});

const providerList: Record<ModelProvider, any> = {
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
  minimax: (modelName: string) =>
    config.MINIMAX_API_FORMAT === "anthropic"
      ? minimaxAnthropic(modelName)
      : minimaxOpenAI.chat(modelName),
};

export function getModel(
  name: string,
  provider: ModelProvider = defaultProvider,
) {
  if (name === "gemini-2.5-pro") {
    name = "gemini-2.5-pro";
  }
  const modelName = config.MODEL_NAME || name;
  // o3-mini returns empty text via the Responses API — force Chat Completions
  if (provider === "openai" && modelName.startsWith("o3-mini")) {
    return providerList.openai.chat(modelName);
  }
  return providerList[provider](modelName);
}

export function getEmbeddingModel(
  name: string,
  provider: ModelProvider = defaultEmbeddingProvider,
) {
  return config.MODEL_EMBEDDING_NAME
    ? providerList[provider].embedding(config.MODEL_EMBEDDING_NAME)
    : providerList[provider].embedding(name);
}
