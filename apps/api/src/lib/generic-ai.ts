// Keep the config import first: it removes an empty OPENAI_BASE_URL from the
// environment, and @ai-sdk/openai throws on one as soon as it is loaded.
import { config } from "../config";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { anthropic as keyedAnthropic } from "@ai-sdk/anthropic";
import { groq } from "@ai-sdk/groq";
import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fireworks } from "@ai-sdk/fireworks";
import { deepinfra } from "@ai-sdk/deepinfra";
import { createVertex } from "@ai-sdk/google-vertex";
import { withUsageTelemetry } from "./ai-usage-telemetry";
import { createFederatedAnthropic } from "./anthropic-federation";
import { createFederatedOpenAI } from "./openai-federation";
import { isUsOnly } from "./us-only";
import { UsOnlyUnavailableError } from "../scraper/scrapeURL/error";
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

// Parse Vertex credentials eagerly so malformed configuration fails fast when
// this module loads, while SDK clients stay lazily constructed on first use.
const vertexAuthOptions = config.VERTEX_CREDENTIALS
  ? {
      credentials: JSON.parse(atob(config.VERTEX_CREDENTIALS)),
    }
  : config.VERTEX_USE_ADC
    ? undefined
    : {
        keyFile: "./gke-key.json",
      };

// An API key wins while it is set, so federation can be rolled out next to it.
const getAnthropicClient = once(() =>
  !config.ANTHROPIC_API_KEY &&
  config.ANTHROPIC_FEDERATION_RULE_ID &&
  config.ANTHROPIC_ORGANIZATION_ID
    ? createFederatedAnthropic(
        config.ANTHROPIC_FEDERATION_RULE_ID,
        config.ANTHROPIC_ORGANIZATION_ID,
      )
    : keyedAnthropic,
);

const getOpenAIClient = once(() =>
  !config.OPENAI_API_KEY &&
  config.OPENAI_IDENTITY_PROVIDER_ID &&
  config.OPENAI_SERVICE_ACCOUNT_ID
    ? createFederatedOpenAI(
        config.OPENAI_IDENTITY_PROVIDER_ID,
        config.OPENAI_SERVICE_ACCOUNT_ID,
      )
    : createOpenAI({
        apiKey: config.OPENAI_API_KEY,
        baseURL: config.OPENAI_BASE_URL,
      }),
);

const getOllamaClient = once(() =>
  createOllama({
    baseURL: config.OLLAMA_BASE_URL,
  }),
);

const getOpenRouterClient = once(() =>
  createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY,
  }),
);

const getVertexClient = once(() =>
  createVertex({
    project: "firecrawl",
    //https://github.com/vercel/ai/issues/6644 bug
    baseURL:
      "https://aiplatform.googleapis.com/v1/projects/firecrawl/locations/global/publishers/google",
    location: "global",
    googleAuthOptions: vertexAuthOptions,
  }),
);

// Without its own key or service account the US client must not exist:
// createOpenAI would fall back to the OPENAI_API_KEY environment variable. The
// endpoint is fixed so no configuration can send US-only traffic elsewhere.
const usOpenAIBaseURL = "https://us.api.openai.com/v1";
const getUsOpenAIClient = once(() =>
  config.OPENAI_US_API_KEY
    ? createOpenAI({
        apiKey: config.OPENAI_US_API_KEY,
        baseURL: usOpenAIBaseURL,
      })
    : config.OPENAI_IDENTITY_PROVIDER_ID && config.OPENAI_US_SERVICE_ACCOUNT_ID
      ? createFederatedOpenAI(
          config.OPENAI_IDENTITY_PROVIDER_ID,
          config.OPENAI_US_SERVICE_ACCOUNT_ID,
          usOpenAIBaseURL,
        )
      : undefined,
);

const getUsVertexClient = once(() =>
  createVertex({
    project: "firecrawl",
    baseURL:
      "https://aiplatform.us.rep.googleapis.com/v1/projects/firecrawl/locations/us/publishers/google",
    location: "us",
    googleAuthOptions: vertexAuthOptions,
  }),
);

// Models offered on the `us` multi-region endpoint, which keeps ML processing
// in the US. Any other model is refused for US-only teams.
const usVertexModels = new Set([
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
]);

const usInferenceGeo: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: {
      ...params.providerOptions,
      anthropic: { ...params.providerOptions?.anthropic, inferenceGeo: "us" },
    },
  }),
};

function usOnlyUnavailable(feature = "The model this request needs") {
  return new UsOnlyUnavailableError(
    `${feature} is not available for teams restricted to US-only processing.`,
  );
}

/** Built-in LLM providers registered by `coreParts()`. */
export const coreLlmProviders: readonly LlmProvider[] = Object.freeze([
  {
    name: "openai",
    enabled: () =>
      Boolean(
        config.OPENAI_API_KEY ||
          config.OPENAI_BASE_URL ||
          (config.OPENAI_IDENTITY_PROVIDER_ID &&
            config.OPENAI_SERVICE_ACCOUNT_ID) ||
          config.OPENAI_US_API_KEY ||
          (config.OPENAI_IDENTITY_PROVIDER_ID &&
            config.OPENAI_US_SERVICE_ACCOUNT_ID),
      ),
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        const client = getUsOpenAIClient();
        if (!client) {
          throw usOnlyUnavailable(options?.feature);
        }
        return modelName.startsWith("o3-mini")
          ? client.chat(modelName)
          : client(modelName);
      }
      const client = getOpenAIClient();
      // o3-mini returns empty text via the Responses API - force Chat Completions
      return modelName.startsWith("o3-mini")
        ? client.chat(modelName)
        : client(modelName);
    },
  },
  {
    name: "ollama",
    enabled: () => Boolean(config.OLLAMA_BASE_URL),
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        throw usOnlyUnavailable(options?.feature);
      }
      return getOllamaClient()(modelName);
    },
  },
  {
    name: "anthropic",
    enabled: () =>
      Boolean(
        config.ANTHROPIC_API_KEY ||
          (config.ANTHROPIC_FEDERATION_RULE_ID &&
            config.ANTHROPIC_ORGANIZATION_ID),
      ),
    model(modelName, options) {
      const model = getAnthropicClient()(modelName);
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        return wrapLanguageModel({
          model,
          middleware: usInferenceGeo,
        });
      }
      return model;
    },
  },
  {
    name: "groq",
    enabled: () => Boolean(process.env.GROQ_API_KEY),
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        throw usOnlyUnavailable(options?.feature);
      }
      return groq(modelName);
    },
  },
  {
    name: "google",
    enabled: () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        throw usOnlyUnavailable(options?.feature);
      }
      return google(modelName);
    },
  },
  {
    name: "openrouter",
    enabled: () => Boolean(config.OPENROUTER_API_KEY),
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        throw usOnlyUnavailable(options?.feature);
      }
      return getOpenRouterClient()(modelName);
    },
  },
  {
    name: "fireworks",
    enabled: () => Boolean(process.env.FIREWORKS_API_KEY),
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        throw usOnlyUnavailable(options?.feature);
      }
      return fireworks(modelName);
    },
  },
  {
    name: "deepinfra",
    enabled: () => Boolean(process.env.DEEPINFRA_API_KEY),
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        throw usOnlyUnavailable(options?.feature);
      }
      return deepinfra(modelName);
    },
  },
  {
    name: "vertex",
    enabled: () => Boolean(config.VERTEX_CREDENTIALS) || config.VERTEX_USE_ADC,
    model(modelName, options) {
      if (isUsOnly(options?.teamFlags ?? undefined)) {
        if (!usVertexModels.has(modelName)) {
          throw usOnlyUnavailable(options?.feature);
        }
        return getUsVertexClient()(modelName);
      }
      return getVertexClient()(modelName);
    },
  },
]);

type ModelOptions = LlmModelOptions & {
  ignoreModelOverride?: boolean;
};

export function getModel(
  name: string,
  provider?: LlmProviderName,
  options?: ModelOptions,
): LlmModel {
  const modelName = options?.ignoreModelOverride
    ? name
    : config.MODEL_NAME || name;
  const providerName: LlmProviderName =
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
