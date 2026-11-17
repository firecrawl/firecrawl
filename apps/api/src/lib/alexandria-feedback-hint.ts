import { config } from "../config";
import type { TeamFlags } from "../controllers/v2/types";
import { getSearchZDR } from "./zdr-helpers";

const RATING = "<good|partial|bad>";
const WEBSITE = "<website the data is about>";
const NEEDED = "<what you needed from it>";
const OBJECTIVE = "<the underlying goal>";
const RATIONALE = "<what was right, wrong or missing>";

/** Whether the team can send Alexandria feedback that is stored, so the next step is worth offering. */
export function alexandriaFeedbackHintApplies(
  teamId: string,
  flags: (TeamFlags & { searchFeedbackOptOut?: boolean }) | null | undefined,
): boolean {
  return (
    config.ALEXANDRIA_FEEDBACK_HINT_ENABLED &&
    config.USE_DB_AUTHENTICATION === true &&
    flags?.searchFeedbackOptOut !== true &&
    !/^preview(_|$)/.test(teamId) &&
    !["forced-zdr", "forced-anon"].includes(getSearchZDR(flags ?? undefined))
  );
}

/**
 * The next step attached to an Alexandria answer: how to rate it through the
 * caller's own feedback surface. Clients that do not know the field pass it
 * through with the rest of the result.
 */
export function alexandriaFeedbackNextStep(
  origin: string,
  integration?: string | null,
) {
  const refund = config.FEEDBACK_REFUND_ENABLED
    ? " Eligible feedback can refund 1 credit."
    : "";
  const fields = {
    endpoint: "alexandria",
    rating: RATING,
    requestedWebsite: { url: WEBSITE, requestedFunctionality: NEEDED },
    objective: OBJECTIVE,
    rationale: RATIONALE,
  };
  const caller = origin.trim().toLowerCase();
  if (caller.startsWith("cli") || integration?.trim().toLowerCase() === "cli")
    return {
      instruction: `Next: once you have used this result, run this command to rate it.${refund}`,
      command: `firecrawl alexandria feedback --rating "${RATING}" --url "${WEBSITE}" --requested-functionality "${NEEDED}" --objective "${OBJECTIVE}" --rationale "${RATIONALE}"`,
    };
  if (caller.startsWith("mcp"))
    return {
      instruction: `Next: once you have used this result, rate it with firecrawl_feedback if that tool is available.${refund}`,
      tool: "firecrawl_feedback",
      arguments: fields,
    };
  return {
    instruction: `Next: once you have used this result, POST /v2/feedback to rate it.${refund}`,
    request: "POST /v2/feedback",
    body: { ...fields, tokens: ["<feedbackToken of each result you rate>"] },
  };
}
