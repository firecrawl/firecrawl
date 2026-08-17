import type { Request } from "express";
import { config } from "../config";

/**
 * TEMPORARY mitigation for keyless (unauthenticated) abuse of the Research
 * Index paper endpoints. Keyless callers get a per-IP daily request/credit
 * budget, but the paper operations are zero-credit and keyless requests never
 * reach the per-minute limiter, so a harvest sharded across enough keyless
 * identities enumerates the index for free. Until there is a permanent fix,
 * `RESEARCH_KEYLESS_DISABLED` makes the selected paper operations require an
 * API key. Unsetting the variable restores today's behaviour with no deploy.
 *
 * This only removes the keyless allowance: requests carrying an API key take
 * the normal authenticated path and are unaffected, as are rate limits, credit
 * costs, and billing.
 */
type ResearchPaperOperation = "search" | "inspect" | "read" | "similar";

/**
 * The paper operation a Research Index request performs, or null if it is not a
 * paper operation (e.g. `/github`). Matching starts at the `papers` segment, so
 * this works both on the path Express hands a mounted router (mount prefix
 * stripped) and on a full request path.
 */
function researchPaperOperation(req: Request): ResearchPaperOperation | null {
  // Express routes case-insensitively by default, so classify that way too —
  // otherwise `/PAPERS/2401.00001` would reach the controller ungated.
  const segments = req.path.toLowerCase().split("/").filter(Boolean);
  const papersIndex = segments.indexOf("papers");
  if (papersIndex === -1) return null;

  const rest = segments.slice(papersIndex + 1);
  if (rest.length === 0) return "search";
  // `/papers/:id` serves both operations: reading a paper against a query, or
  // inspecting its metadata when no query is given.
  if (rest.length === 1) {
    return req.query?.query === undefined ? "inspect" : "read";
  }
  if (rest.length === 2 && rest[1] === "similar") return "similar";
  return null;
}

/**
 * Whether this Research Index request must present an API key because its
 * operation is in the `RESEARCH_KEYLESS_DISABLED` scope.
 */
export function isResearchKeylessDisabled(req: Request): boolean {
  const disabledOperations = config.RESEARCH_KEYLESS_DISABLED;
  if (disabledOperations.length === 0) return false;

  const operation = researchPaperOperation(req);
  return operation !== null && disabledOperations.includes(operation);
}
