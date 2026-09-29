import { z } from "zod";
import { config } from "../config";
import { logger as rootLogger } from "./logger";

// Disabled until customer billing and provider-access checks are integrated.

const PLAN_TIMEOUT_MS = 4_000;
const STEP_TIMEOUT_MS = 45_000;

// Exchange decides what a supported URL is; this is only a cheap pre-filter so
// the plan call is not made for every scrape. Keep it in step with the
// `sourceUrls` the enrichment candidates publish.
const PROFILE_URL_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/[^/?#]+/i;

const stepSchema = z
  .object({
    provider: z.string(),
    capability: z.string(),
    providerName: z.string().optional(),
    creditsCost: z.number().int().nonnegative(),
    perRecord: z.boolean().optional(),
    termsRequired: z.boolean().optional(),
    input: z.record(z.string(), z.string()),
  })
  .passthrough();

const planSchema = z
  .object({
    plan: z
      .object({
        entity: z.string(),
        outcome: z.string(),
        url: z.string(),
        enabled: z.boolean(),
        matched: z.boolean(),
        mode: z.enum(["single", "waterfall"]),
        maxCreditsPerUrl: z.number().int().nonnegative(),
        version: z.number().int().nullable(),
        steps: z.array(stepSchema),
        dropped: z.array(z.object({ provider: z.string(), capability: z.string() })),
        maxCredits: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();
export type EnrichmentPlan = z.infer<typeof planSchema>["plan"];
export type EnrichmentStep = z.infer<typeof stepSchema>;

const retrieveSuccessSchema = z
  .object({
    provider: z.string(),
    capability: z.string(),
    creditsCost: z.number().int().nonnegative(),
    data: z.unknown(),
    records: z.number().int().nonnegative().optional(),
    upstreamStatus: z.number().optional(),
  })
  .passthrough();
const retrieveFailureSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
  })
  .passthrough();

export type EnrichmentStepOutcome = "matched" | "no_match" | "error" | "skipped";
export type EnrichmentAttempt = {
  provider: string;
  capability: string;
  outcome: EnrichmentStepOutcome;
  creditsCost: number;
  error?: { code: string; message: string };
};
export type ScrapeEnrichmentSummary = {
  entity: string;
  outcome: string;
  mode: "single" | "waterfall";
  status: "matched" | "no_match" | "error" | "budget_exceeded";
  provider?: string;
  capability?: string;
  data?: unknown;
  creditsCost: number;
  attempted: EnrichmentAttempt[];
  preferenceVersion: number | null;
};

export type EnrichmentContext = {
  teamId: string;
  requestId: string;
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function exchangeBase(): string | null {
  return config.FIRE_EXCHANGE_URL ? config.FIRE_EXCHANGE_URL.replace(/\/+$/, "") : null;
}

export function isEnrichmentCandidateUrl(url: string): boolean {
  return PROFILE_URL_PATTERN.test(url);
}

/** The team's plan for this URL, or null when there is nothing to run. Never throws. */
export async function planEnrichment(
  context: EnrichmentContext,
  outcome: "profile" | "work_email" = "profile",
): Promise<EnrichmentPlan | null> {
  const base = exchangeBase();
  if (!base || !isEnrichmentCandidateUrl(context.url)) return null;
  const logger = rootLogger.child({ module: "exchange-enrichment", teamId: context.teamId });
  try {
    const response = await (context.fetchImpl ?? fetch)(`${base}/v1/enrichment/plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-exchange-team-id": context.teamId,
        "x-request-id": context.requestId,
      },
      body: JSON.stringify({ url: context.url, outcome, entity: "person" }),
      signal: context.signal ?? AbortSignal.timeout(PLAN_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("Enrichment plan request failed", { statusCode: response.status });
      return null;
    }
    const { plan } = planSchema.parse(await response.json());
    return plan.enabled && plan.matched && plan.steps.length > 0 ? plan : null;
  } catch (error) {
    logger.warn("Enrichment plan request errored", { error });
    return null;
  }
}

function classify(data: unknown, records: number | undefined): "matched" | "no_match" {
  if (records !== undefined) return records > 0 ? "matched" : "no_match";
  if (data === null || data === undefined) return "no_match";
  if (Array.isArray(data)) return data.length > 0 ? "matched" : "no_match";
  if (typeof data === "object") return Object.keys(data as object).length > 0 ? "matched" : "no_match";
  return "matched";
}

// Try providers in order and stop at the first match or error.
export async function runEnrichmentPlan(
  plan: EnrichmentPlan,
  context: EnrichmentContext,
): Promise<ScrapeEnrichmentSummary> {
  const base = exchangeBase();
  const logger = rootLogger.child({ module: "exchange-enrichment", teamId: context.teamId });
  const attempted: EnrichmentAttempt[] = [];
  let spent = 0;
  const summary = (status: ScrapeEnrichmentSummary["status"], extra: Partial<ScrapeEnrichmentSummary> = {}): ScrapeEnrichmentSummary => ({
    entity: plan.entity,
    outcome: plan.outcome,
    mode: plan.mode,
    status,
    creditsCost: spent,
    attempted,
    preferenceVersion: plan.version,
    ...extra,
  });
  if (!base) return summary("error");

  for (const step of plan.steps) {
    if (spent + step.creditsCost > plan.maxCredits) {
      attempted.push({ provider: step.provider, capability: step.capability, outcome: "skipped", creditsCost: 0 });
      logger.info("Enrichment step skipped: budget", { provider: step.provider, capability: step.capability, spent, maxCredits: plan.maxCredits });
      return summary("budget_exceeded");
    }
    try {
      const response = await (context.fetchImpl ?? fetch)(`${base}/v1/retrieve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-exchange-team-id": context.teamId,
          "x-request-id": `${context.requestId}:${attempted.length + 1}`,
        },
        body: JSON.stringify({ provider: step.provider, capability: step.capability, options: step.input }),
        signal: context.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = response.ok ? retrieveSuccessSchema.safeParse(body) : { success: false as const };
      if (!parsed.success) {
        const failure = retrieveFailureSchema.safeParse(body);
        const error = failure.success
          ? { code: failure.data.error.code, message: failure.data.error.message }
          : { code: `http_${response.status}`, message: "Exchange returned an unexpected response." };
        attempted.push({ provider: step.provider, capability: step.capability, outcome: "error", creditsCost: 0, error });
        logger.warn("Enrichment step failed", { provider: step.provider, capability: step.capability, ...error });
        return summary("error");
      }
      const result = parsed.data;
      spent += result.creditsCost;
      const outcome = classify(result.data, result.records);
      attempted.push({ provider: step.provider, capability: step.capability, outcome, creditsCost: result.creditsCost });
      if (outcome === "matched")
        return summary("matched", { provider: step.provider, capability: step.capability, data: result.data });
      if (plan.mode === "single") break;
    } catch (error) {
      attempted.push({
        provider: step.provider,
        capability: step.capability,
        outcome: "error",
        creditsCost: 0,
        error: { code: "request_failed", message: error instanceof Error ? error.message : String(error) },
      });
      logger.warn("Enrichment step errored", { provider: step.provider, capability: step.capability, error });
      return summary("error");
    }
  }
  return summary("no_match");
}

/** Plan and run in one call for the scrape controller. Undefined means "nothing to attach". */
export async function enrichScrape(
  context: EnrichmentContext,
): Promise<ScrapeEnrichmentSummary | undefined> {
  if (config.EXCHANGE_ENRICHMENT_ON_SCRAPE !== true) return undefined;
  const plan = await planEnrichment(context);
  if (!plan) return undefined;
  return runEnrichmentPlan(plan, context);
}
