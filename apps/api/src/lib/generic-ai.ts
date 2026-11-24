// Keep the config import first: it removes an empty OPENAI_BASE_URL from the
// environment, and @ai-sdk/openai throws on one as soon as it is loaded.
import { config } from "../config";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider-v2";
import { withUsageTelemetry } from "./ai-usage-telemetry";
import {
  service,
  type LlmModel,
  type LlmModelOptions,
  type LlmProvider,
  type LlmProviderName,
} from "../service";

function once<T>(create: () => T): () => T {
  let initialized = false;
  let value: T;
  return () => {
    if (!initialized) {
      value = create();
      initialized = true;
    }
    return value;
  };
}

const getOpenAIClient = once(() =>
  createOpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.OPENAI_BASE_URL,
  }),
);

const getOllamaClient = once(() =>
  createOllama({
    baseURL: config.OLLAMA_BASE_URL,
  }),
);

/** Built-in LLM providers registered by `coreParts()`. */
export const coreLlmProviders: readonly LlmProvider[] = Object.freeze([
  {
    name: "openai",
    enabled: () => Boolean(config.OPENAI_API_KEY || config.OPENAI_BASE_URL),
    model(modelName) {
      const client = getOpenAIClient();
      return modelName.startsWith("o3-mini")
        ? client.chat(modelName)
        : client(modelName);
    },
  },
  {
    name: "ollama",
    enabled: () => Boolean(config.OLLAMA_BASE_URL),
    model(modelName) {
      return getOllamaClient()(modelName);
    },
  },
]);

type ModelOptions = LlmModelOptions & {
  ignoreModelOverride?: boolean;
};

export function getModel(
  name: string,
  provider?: LlmProviderName | (string & {}),
  options?: ModelOptions,
): LlmModel {
  const modelName = options?.ignoreModelOverride
    ? name
    : config.MODEL_NAME || name;
  const providerName: string =
    provider ?? (config.OLLAMA_BASE_URL ? "ollama" : "openai");
  const registered = service.llmProviders.get(providerName);
  if (!registered) {
    throw new Error(`LLM provider "${providerName}" is not registered`);
  }
  return withUsageTelemetry(
    registered.model(modelName, {
      ctx: options?.ctx,
      teamFlags: options?.teamFlags,
      feature: options?.feature,
    }),
  );
}
