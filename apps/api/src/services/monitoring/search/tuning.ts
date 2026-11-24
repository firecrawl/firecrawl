import { getModel } from "../../../lib/generic-ai";
import { service } from "../../../service";
import type { TeamFlags } from "../../../controllers/v2/types";

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

// Prefer Vertex when registered and enabled so usage is traceable via Vertex
// billing labels; fall back to the google provider otherwise.
function hasVertex(): boolean {
  return service.llmProviders.get("vertex")?.enabled() ?? false;
}

export function hasLlmProvider(): boolean {
  return hasVertex() || Boolean(geminiApiKey());
}

export function googleModel(
  modelId: string,
  options?: { teamFlags?: TeamFlags | null; feature?: string },
) {
  return getModel(modelId, hasVertex() ? "vertex" : "google", options);
}

export function googleProviderOptions(
  functionId: string,
  labels?: LlmUsageLabels,
) {
  const provider = hasVertex() ? "vertex" : "google";

  const options: {
    thinkingConfig: { thinkingLevel: "minimal" };
    labels?: Record<string, string>;
  } = {
    thinkingConfig: { thinkingLevel: "minimal" },
  };
  // Billing labels are Vertex-only; the GenAI provider ignores them.
  if (provider === "vertex" && labels) {
    options.labels = { functionId, ...labels };
  }

  return { providerOptions: { [provider]: options } };
}
