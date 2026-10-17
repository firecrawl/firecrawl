import { createHash } from "crypto";
import { config } from "../config";

/**
 * Routing for the optional JSON extraction provider (EXTRACTION_PROVIDER_*).
 *
 * A team lands in a stable cohort bucket 0-99 (sha1 of the team id), so a
 * rollout percentage selects the same teams every time and can be widened
 * without reshuffling. Buckets below ROLLOUT_PERCENT are routed; the next
 * SHADOW_PERCENT buckets are mirrored (the provider is called, the result is
 * discarded). Teams listed in TEAM_IDS are always routed. Zero-data-retention
 * requests and inputs over MAX_INPUT_BYTES stay on the default model.
 *
 * A request may also name the provider model explicitly (json format `model`);
 * that routes it regardless of cohort when the team is listed in TEAM_IDS or
 * REQUEST_OPT_IN is on. Unknown model names are rejected at validation.
 */
type ExtractionRoute = "provider" | "shadow" | "default";

function isExtractionProviderConfigured(): boolean {
  return !!config.EXTRACTION_PROVIDER_BASE_URL;
}

export function cohortBucket(teamId: string): number {
  const digest = createHash("sha1").update(teamId).digest();
  return digest.readUInt32BE(0) % 100;
}

function allowlistedTeams(): Set<string> {
  return new Set(
    (config.EXTRACTION_PROVIDER_TEAM_IDS ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
  );
}

/** Model names a request may ask for in the json format `model` field. */
export function isRequestedModelSupported(model: string): boolean {
  return (
    isExtractionProviderConfigured() &&
    model === config.EXTRACTION_PROVIDER_MODEL
  );
}

export function selectExtractionRoute(input: {
  teamId: string | undefined;
  zeroDataRetention: boolean;
  inputBytes: number;
  requestedModel?: string;
}): ExtractionRoute {
  if (!isExtractionProviderConfigured()) return "default";
  if (input.zeroDataRetention) return "default";
  if (input.inputBytes > config.EXTRACTION_PROVIDER_MAX_INPUT_BYTES)
    return "default";
  if (!input.teamId) return "default";
  const listed = allowlistedTeams().has(input.teamId);
  if (input.requestedModel !== undefined) {
    return isRequestedModelSupported(input.requestedModel) &&
      (listed || config.EXTRACTION_PROVIDER_REQUEST_OPT_IN)
      ? "provider"
      : "default";
  }
  if (listed) return "provider";
  const bucket = cohortBucket(input.teamId);
  if (bucket < config.EXTRACTION_PROVIDER_ROLLOUT_PERCENT) return "provider";
  if (
    bucket <
    config.EXTRACTION_PROVIDER_ROLLOUT_PERCENT +
      config.EXTRACTION_PROVIDER_SHADOW_PERCENT
  )
    return "shadow";
  return "default";
}

/** Per-million-token prices for the provider model (amortized infrastructure cost, configured). */
export function extractionProviderCost(
  model: string,
): { input_cost: number; output_cost: number } | undefined {
  if (!isExtractionProviderConfigured()) return undefined;
  if (model !== config.EXTRACTION_PROVIDER_MODEL) return undefined;
  return {
    input_cost: config.EXTRACTION_PROVIDER_INPUT_COST_PER_MTOK,
    output_cost: config.EXTRACTION_PROVIDER_OUTPUT_COST_PER_MTOK,
  };
}
