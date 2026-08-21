import type { $ZodIssue } from "zod/v4/core";

const MAX_ISSUES_IN_MESSAGE = 2;
const MAX_MESSAGE_LENGTH = 512;

function renderPath(path: PropertyKey[]): string {
  return path.map(segment => String(segment)).join(".");
}

/**
 * A branch that rejected the payload's literal discriminator (`type`, `format`,
 * ...) is a branch the caller never meant to hit -- reporting "expected \"crawl\""
 * for a payload that clearly said `"type": "scrape"` sends people after the wrong
 * field. Such a branch is non-matching no matter what else it complains about, so
 * test for the discriminator failure alone rather than requiring it be the only
 * issue: a mismatched branch also reports every field it is missing.
 */
function isNonMatchingBranch(issues: readonly $ZodIssue[]): boolean {
  return issues.some(
    issue =>
      issue.code === "invalid_value" &&
      // A literal permits exactly one value; an enum (searchWindow, status, ...)
      // permits several and is an ordinary field the caller got wrong, not a
      // discriminator saying "wrong branch".
      issue.values.length === 1 &&
      // Depth 1 is a discriminator property (`{ type: "scrape" }`); depth 0 is a
      // bare-literal branch (`z.literal("pdf")` beside an object form) that the
      // payload plainly is not. Deeper than that is an ordinary nested field.
      issue.path.length <= 1,
  );
}

/**
 * Flatten zod issues into `{ path, message }` pairs, descending into
 * `invalid_union` branches. Branch paths are relative to the union node, so the
 * union's own path is prefixed back on as we recurse.
 */
function flattenIssues(
  issues: readonly $ZodIssue[],
  basePath: PropertyKey[] = [],
): { path: string; message: string }[] {
  const flattened: { path: string; message: string }[] = [];

  for (const issue of issues) {
    const path = [...basePath, ...issue.path];

    if (issue.code === "invalid_union") {
      const branches = (issue.errors ?? []) as $ZodIssue[][];
      const informative = branches.filter(
        branch => branch.length > 0 && !isNonMatchingBranch(branch),
      );
      const chosen = informative.length > 0 ? informative : branches;
      if (chosen.length > 0) {
        flattened.push(...flattenIssues(chosen[0], path));
        continue;
      }
    }

    flattened.push({ path: renderPath(path), message: issue.message });
  }

  return flattened;
}

/**
 * Build the user-facing `error` string for a zod validation failure.
 *
 * Every issue code other than `unrecognized_keys` and a leading `custom` used to
 * collapse to the literal string "Bad Request", which is all a client sees --
 * the real issues only ever reached the `details` array. See issue #4054, where
 * a create-monitor call failed with nothing but "Bad Request" to go on.
 *
 * Returns null when no issue yields anything worth showing, so the caller keeps
 * its own fallback.
 */
export function formatZodIssues(issues: readonly $ZodIssue[]): string | null {
  const flattened = flattenIssues(issues).filter(x => x.message);
  if (flattened.length === 0) return null;

  const shown = flattened
    .slice(0, MAX_ISSUES_IN_MESSAGE)
    .map(({ path, message }) => (path ? `${path}: ${message}` : message))
    .join("; ");
  const remaining = flattened.length - MAX_ISSUES_IN_MESSAGE;
  const message =
    remaining > 0
      ? `${shown} (and ${remaining} more validation ${remaining === 1 ? "error" : "errors"})`
      : shown;

  return message.length > MAX_MESSAGE_LENGTH
    ? message.slice(0, MAX_MESSAGE_LENGTH - 1) + "…"
    : message;
}
