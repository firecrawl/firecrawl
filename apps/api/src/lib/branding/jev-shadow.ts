import { differenceCiede2000, parse } from "culori";

import { config } from "../../config";
import { CostTracking } from "../cost-tracking";
import { setSpanAttributes, withSpan } from "../otel-tracer";
import { enhanceBrandingWithJev, isJevBreakerOpen } from "./jev";
import { mergeBrandingResults } from "./merge";
import { BrandingEnhancement } from "./schema";
import { BrandingLLMInput } from "./types";
import { BrandingProfile } from "../../types/branding";

// Shadow mode: for a sample of requests the LLM answered, ask Jev the same
// questions in the background and record on a span how the two answers would
// differ in the response. Customers always get the LLM's answer.

// Colors closer than this (CIEDE2000) count as the same; brand-bench's default
// tolerance is 12.
const SAME_COLOR_DELTA_E = 10;
// Backstop for traffic bursts: past this many shadow calls in flight, skip.
const MAX_IN_FLIGHT = 50;

let inFlight = 0;

export function shouldShadowJev(input: BrandingLLMInput): boolean {
  if (!config.TYPESAFE_API_KEY) return false;
  // TypeSafe keeps nothing, but ZDR requests should not do extra work on
  // customer content that is not needed for their response.
  if (input.zeroDataRetention === true) return false;
  const percent = config.BRANDING_JEV_SHADOW_PERCENT;
  if (percent <= 0) return false;
  if (inFlight >= MAX_IN_FLIGHT) return false;
  // No extra load on TypeSafe while branding has stopped calling it.
  if (isJevBreakerOpen()) return false;
  return Math.random() * 100 < percent;
}

const deltaE = differenceCiede2000();

function sameColor(a?: string, b?: string): boolean {
  if (!a && !b) return true;
  const pa = a ? parse(a) : undefined;
  const pb = b ? parse(b) : undefined;
  if (!pa || !pb) return false;
  return deltaE(pa, pb) <= SAME_COLOR_DELTA_E;
}

const COLOR_ROLES = ["primary", "accent", "background", "textPrimary"] as const;

type ButtonStyle = NonNullable<
  NonNullable<BrandingProfile["components"]>["buttonPrimary"]
>;

// Everything the response carries for a button.
function sameButton(a?: ButtonStyle, b?: ButtonStyle): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const sameText = (x?: string, y?: string) => (x || "none") === (y || "none");
  return (
    sameColor(a.background, b.background) &&
    sameColor(a.textColor, b.textColor) &&
    sameColor(a.borderColor, b.borderColor) &&
    sameText(a.borderRadius, b.borderRadius) &&
    sameText(a.shadow, b.shadow)
  );
}

// Merge keeps the page's own fonts when an answer cleans none, so compare the
// merged profiles, not the raw answers.
function fontOverlap(a: BrandingProfile, b: BrandingProfile): number {
  const names = (p: BrandingProfile) =>
    new Set((p.fonts ?? []).map(f => f.family.toLowerCase()));
  const x = names(a);
  const y = names(b);
  const union = new Set([...x, ...y]);
  if (union.size === 0) return 1;
  return [...x].filter(f => y.has(f)).length / union.size;
}

/**
 * Agreement between two answers to the same branding questions, measured on
 * what the response would contain after merge: logo, button styles, color roles
 * and fonts.
 */
export function compareBrandingAnswers(
  input: Pick<BrandingLLMInput, "jsAnalysis" | "buttons" | "logoCandidates">,
  llm: BrandingEnhancement,
  jev: BrandingEnhancement,
): Record<string, boolean | number> {
  // merge edits nested objects of the profile it is given; each side gets its own copy.
  const merged = (answer: BrandingEnhancement): BrandingProfile =>
    mergeBrandingResults(
      structuredClone(input.jsAnalysis),
      structuredClone(answer),
      structuredClone(input.buttons ?? []),
      structuredClone(input.logoCandidates),
    );
  const a = merged(llm);
  const b = merged(jev);

  const result: Record<string, boolean | number> = {};
  if ((input.logoCandidates?.length ?? 0) > 0) {
    result.logo_agree = (a.images?.logo ?? null) === (b.images?.logo ?? null);
  }
  result.button_primary_agree = sameButton(
    a.components?.buttonPrimary,
    b.components?.buttonPrimary,
  );
  result.button_secondary_agree = sameButton(
    a.components?.buttonSecondary,
    b.components?.buttonSecondary,
  );
  for (const role of COLOR_ROLES) {
    result[`color_${role}_agree`] = sameColor(
      a.colors?.[role],
      b.colors?.[role],
    );
  }
  result.fonts_overlap = fontOverlap(a, b);

  const flags = Object.values(result).filter(
    (v): v is boolean => typeof v === "boolean",
  );
  result.fields_compared = flags.length;
  result.fields_agreeing = flags.filter(Boolean).length;
  return result;
}

/**
 * Starts the shadow call and returns at once. Inputs are copied before
 * returning: the caller keeps editing the LLM answer and the profile.
 */
export function shadowJev(
  input: BrandingLLMInput,
  llm: BrandingEnhancement,
  llmModel: string,
): Promise<void> {
  const snapshot: BrandingLLMInput = {
    ...input,
    jsAnalysis: structuredClone(input.jsAnalysis),
    buttons: structuredClone(input.buttons),
    logoCandidates: structuredClone(input.logoCandidates),
    // Jev does not read these; don't keep large strings alive.
    screenshot: undefined,
    headerHtmlChunk: undefined,
    // Kept apart from the scrape's own cost record and cost limit.
    costTracking: new CostTracking(),
  };
  const llmAnswer = structuredClone(llm);
  inFlight++;

  return withSpan("branding.jev_shadow", async span => {
    setSpanAttributes(span, {
      feature: "branding",
      "branding.shadow.llm_model": llmModel,
      ...(input.teamId ? { "branding.shadow.team_id": input.teamId } : {}),
      ...(input.scrapeId ? { scrapeId: input.scrapeId } : {}),
    });
    const jev = await enhanceBrandingWithJev(snapshot, { shadow: true });
    if (!jev) {
      setSpanAttributes(span, { "branding.shadow.outcome": "jev_failed" });
      return;
    }
    const comparison = compareBrandingAnswers(
      snapshot,
      llmAnswer,
      jev.enhancement,
    );
    setSpanAttributes(span, {
      "branding.shadow.outcome": "compared",
      ...(jev.logoConfidence !== undefined
        ? { "branding.shadow.jev_logo_confidence": jev.logoConfidence }
        : {}),
      ...Object.fromEntries(
        Object.entries(comparison).map(([k, v]) => [`branding.shadow.${k}`, v]),
      ),
    });
  })
    .catch(error => {
      input.logger.warn("Jev branding shadow failed", { error });
    })
    .finally(() => {
      inFlight--;
    });
}
