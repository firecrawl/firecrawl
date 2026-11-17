import type { AuthCreditUsageChunk, TeamFlags } from "../controllers/v1/types";
import { isUsOnly } from "./us-only";
import {
  getAlexandriaZDR,
  getScrapeZDR,
  getSearchZDR,
  isDpaRestricted,
} from "./zdr-helpers";

/**
 * How a team buys Firecrawl: on a free plan, on a plan from the pricing page,
 * or under negotiated terms. The API states it on calls to services whose
 * handling depends on it. Stating no class means nothing is known about the
 * team, and a reader must never take that for `free` or `self_serve`.
 */
export type TeamPlanClass = "free" | "self_serve" | "contract";

/**
 * Switch: Scale bought from the pricing page, with no contract, is self-serve.
 * Set to false, its plan ids read as `contract`.
 */
const PRICING_PAGE_SCALE_IS_SELF_SERVE = true;

/**
 * Switch: a request with no API key and no account is stated as `free`. Set
 * to false, such a request states nothing.
 */
const KEYLESS_IS_FREE = true;

/** What keyless auth states about its callers. Nothing else may use it. */
export const KEYLESS_PLAN_CLASS: TeamPlanClass | undefined = KEYLESS_IS_FREE
  ? "free"
  : undefined;

// The sets below mirror the plan ids of the billing catalog. Every id outside
// them reads as `contract`, so a plan added to the catalog and not here costs
// its teams the `free` or `self_serve` statement and nothing else.
const FREE_PLAN_IDS = new Set(["free", "free_1_5k", "free_no_credits"]);

const PRICING_PAGE_SCALE_PLAN_IDS = ["scale_monthly", "scale_tier_1"];

const SELF_SERVE_PLAN_IDS = new Set([
  "hobby",
  "hobby_yearly",
  "hobby_monthly_5k",
  "hobby_monthly_6_5k",
  "hobby_monthly_8k",
  "hobby_monthly_10k",
  "hobby_monthly_25k",
  "hobby_yearly_5k",
  "hobby_yearly_6_5k",
  "hobby_yearly_8k",
  "hobby_yearly_10k",
  "hobby_yearly_25k",
  "standard",
  "standard_yearly",
  "standard_monthly_100k",
  "standard_monthly_130k",
  "standard_monthly_150k",
  "standard_monthly_160k",
  "standard_monthly_225k",
  "standard_monthly_250k",
  "standard_monthly_350k",
  "standard_yearly_100k",
  "standard_yearly_130k",
  "standard_yearly_150k",
  "standard_yearly_160k",
  "standard_yearly_225k",
  "standard_yearly_250k",
  "standard_yearly_350k",
  "growth",
  "growth_yearly",
  "growth_monthly_500k",
  "growth_monthly_650k",
  "growth_monthly_750k",
  "growth_yearly_500k",
  "growth_yearly_650k",
  "growth_yearly_750k",
  "extract_starter",
  "extract_starter_yearly",
  "extract_explorer_monthly",
  "extract_explorer_yearly",
  "extract_pro",
  "extract_pro_yearly",
  "legacy_starter",
  "legacy_standard",
  ...(PRICING_PAGE_SCALE_IS_SELF_SERVE ? PRICING_PAGE_SCALE_PLAN_IDS : []),
]);

// Add-ons sold beside a self-serve plan. They say nothing about the plan.
const SELF_SERVE_ADD_ON_IDS = new Set([
  "pay_as_you_go",
  "credit_pack_1k",
  "concurrent_browser",
]);

/**
 * The class of an org from the subscriptions billing reports for it, or
 * undefined when they give none.
 *
 * One subscription to a plan this build cannot name makes the org `contract`,
 * whatever its status and whether it is a plan or an add-on, so a status this
 * build does not know can never hide such a plan. Failing that, `free` and
 * `self_serve` each need an active plan of that kind, so an org with no plan
 * on record is never stated as free.
 */
export function planClassOf(
  subscriptions: readonly { planId: string; status: string }[],
): TeamPlanClass | undefined {
  if (
    subscriptions.some(
      ({ planId }) =>
        !FREE_PLAN_IDS.has(planId) &&
        !SELF_SERVE_PLAN_IDS.has(planId) &&
        !SELF_SERVE_ADD_ON_IDS.has(planId),
    )
  ) {
    return "contract";
  }
  const active = subscriptions.filter(({ status }) => status === "active");
  if (active.some(({ planId }) => SELF_SERVE_PLAN_IDS.has(planId))) {
    return "self_serve";
  }
  if (active.some(({ planId }) => FREE_PLAN_IDS.has(planId))) return "free";
  return undefined;
}

/**
 * Whether staff have put the team under negotiated terms: a signed contract,
 * an enterprise pilot that has not ended, or a data-handling term (zero data
 * retention on search, scrape or provider tools, US-only processing, a
 * restricting DPA, a training restriction, Safe Mode). Anything unreadable
 * counts as a term.
 */
function hasNegotiatedTerms(flags: TeamFlags, now: number): boolean {
  if (!flags) return false;
  const pilot = flags.enterprisePilot;
  const pilotEnd = Date.parse(pilot?.endDate ?? "");
  return (
    (flags.signedContract ?? false) !== false ||
    (pilot != null && !(pilotEnd <= now)) ||
    getSearchZDR(flags) !== "disabled" ||
    getScrapeZDR(flags) !== "disabled" ||
    getAlexandriaZDR(flags) !== "disabled" ||
    isUsOnly(flags) ||
    isDpaRestricted(flags) ||
    flags.trainingRestricted === true ||
    flags.safeMode === true
  );
}

/**
 * The plan class to state for the team behind an auth chunk, or undefined to
 * state nothing. A team under negotiated terms is `contract` whatever plan it
 * pays for. Any other team gets the class on its chunk, and there is none
 * when billing did not answer or gave the org no class, when the chunk is a
 * mock other than the keyless one, or when it was cached before the class
 * existed. No chunk states nothing.
 */
export function teamPlanClass(
  acuc: Pick<AuthCreditUsageChunk, "flags" | "plan_class"> | undefined,
  now: number = Date.now(),
): TeamPlanClass | undefined {
  if (!acuc) return undefined;
  return hasNegotiatedTerms(acuc.flags, now) ? "contract" : acuc.plan_class;
}
