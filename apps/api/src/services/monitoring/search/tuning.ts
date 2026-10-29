import type { GoogleLanguageModelOptions } from "@ai-sdk/google";
import { getModel } from "../../../lib/generic-ai";
import { config } from "../../../config";

// Vertex billing labels so every LLM call is traceable at the billing level by
// function, team, monitor, and monitor check (mirrors the Extract code). The
// GenAI provider ignores labels it doesn't understand.
export type LlmUsageLabels = {
  teamId: string;
  monitorId: string;
  monitorCheckId: string;
};

// AI SDK span metadata for a monitor LLM call: the check is the job, so the LLM
// spend dashboard attributes each provider call to its team, monitor and check.
export function monitorTelemetryMetadata(
  feature: string,
  labels?: LlmUsageLabels,
): Record<string, string> {
  return {
    ...(labels
      ? {
          teamId: labels.teamId,
          monitorId: labels.monitorId,
          jobId: labels.monitorCheckId,
        }
      : {}),
    jobKind: "monitor",
    feature,
  };
}

function geminiApiKey(): string | undefined {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
}

// Vertex is the preferred provider so usage is traceable via Vertex billing
// labels; the GenAI (Gemini) API is only a fallback when Vertex credentials
// aren't configured (e.g. self-hosted).
function hasVertex(): boolean {
  return Boolean(config.VERTEX_CREDENTIALS);
}

export function hasLlmProvider(): boolean {
  return hasVertex() || Boolean(geminiApiKey());
}

export function googleModel(modelId: string) {
  return getModel(modelId, hasVertex() ? "vertex" : "google");
}

export function googleProviderOptions(
  functionId: string,
  labels?: LlmUsageLabels,
) {
  const provider = hasVertex() ? "vertex" : "google";

  const options: GoogleLanguageModelOptions = {
    thinkingConfig: { thinkingLevel: "minimal" },
  };
  // Billing labels are Vertex-only; the GenAI provider ignores them.
  if (provider === "vertex" && labels) {
    options.labels = { functionId, ...labels };
  }

  return { providerOptions: { [provider]: options } };
}
