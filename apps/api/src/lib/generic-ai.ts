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
import type { TeamFlags } from "../controllers/v2/types";
import { isUsOnly } from "./us-only";
import { UsOnlyUnavailableError } from "../scraper/scrapeURL/error";

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
const anthropic =
  !config.ANTHROPIC_API_KEY &&
  config.ANTHROPIC_FEDERATION_RULE_ID &&
  config.ANTHROPIC_ORGANIZATION_ID
    ? createFederatedAnthropic(
        config.ANTHROPIC_FEDERATION_RULE_ID,
        config.ANTHROPIC_ORGANIZATION_ID,
      )
    : keyedAnthropic;

const openai =
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
      });

const providerList: Record<Provider, any> = {
  openai, //OPENAI_API_KEY or workload identity federation
  ollama: createOllama({
    baseURL: config.OLLAMA_BASE_URL,
  }),
  anthropic, //ANTHROPIC_API_KEY or workload identity federation
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
    googleAuthOptions: vertexAuthOptions,
  }),
};

// Without its own key or service account the US client must not exist:
// createOpenAI would fall back to the OPENAI_API_KEY environment variable. The
// endpoint is fixed so no configuration can send US-only traffic elsewhere.
const usOpenAIBaseURL = "https://us.api.openai.com/v1";
const usOpenAI = config.OPENAI_US_API_KEY
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
    : undefined;

const usVertex = createVertex({
  project: "firecrawl",
  baseURL:
    "https://aiplatform.us.rep.googleapis.com/v1/projects/firecrawl/locations/us/publishers/google",
  location: "us",
  googleAuthOptions: vertexAuthOptions,
});

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

type ModelOptions = {
  ignoreModelOverride?: boolean;
  /**
   * The requesting team's flags. A US-only team gets a US endpoint, or an
   * UsOnlyUnavailableError naming `feature` when the model has none.
   */
  teamFlags?: TeamFlags | null;
  feature?: string;
};

function usOnlyUnavailable(feature = "The model this request needs") {
  return new UsOnlyUnavailableError(
    `${feature} is not available for teams restricted to US-only processing.`,
  );
}

function getUsOnlyModel(
  modelName: string,
  provider: Provider,
  feature: string | undefined,
) {
  if (provider === "openai" && usOpenAI) {
    return modelName.startsWith("o3-mini")
      ? usOpenAI.chat(modelName)
      : usOpenAI(modelName);
  }
  if (provider === "anthropic") {
    return wrapLanguageModel({
      model: anthropic(modelName),
      middleware: usInferenceGeo,
    });
  }
  if (provider === "vertex" && usVertexModels.has(modelName)) {
    return usVertex(modelName);
  }
  throw usOnlyUnavailable(feature);
}

export function getModel(
  name: string,
  provider: Provider = defaultProvider,
  options?: ModelOptions,
) {
  const modelName = options?.ignoreModelOverride
    ? name
    : config.MODEL_NAME || name;
  if (isUsOnly(options?.teamFlags ?? undefined)) {
    return withUsageTelemetry(
      getUsOnlyModel(modelName, provider, options?.feature),
    );
  }
  // o3-mini returns empty text via the Responses API — force Chat Completions
  if (provider === "openai" && modelName.startsWith("o3-mini")) {
    return withUsageTelemetry(providerList.openai.chat(modelName));
  }
  return withUsageTelemetry(providerList[provider](modelName));
}
