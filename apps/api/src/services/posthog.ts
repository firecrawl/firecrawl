import { and, eq, sql } from "drizzle-orm";
import { db, dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { logger as _logger } from "../lib/logger";
import { capturePostHog, isPostHogCaptureEnabled } from "./posthog-capture";

/** Normalized request surface, derived from the `origin` + `integration` fields. */
type RequestSurface =
  | "playground"
  | "sdk"
  | "mcp"
  | "cli"
  | "api"
  | "monitor"
  | "other";

/**
 * Map a request's `origin` + `integration` fields to a coarse surface category.
 *
 * Both are client-set. `origin` (defaults to "api") carries the SDK
 * (`*-sdk@ver`, `api-sdk`), MCP (`mcp` / `mcp-fastmcp`), playground (`website`),
 * and `monitor`. The CLI is the exception: it sets `integration: "cli"` on every
 * command but leaves `origin` at the "api" default on its high-volume commands
 * (scrape/crawl/search/map/agent/parse/browser) — only feedback/interact/
 * search-feedback also set `origin: "cli"`. So CLI must be detected via
 * `integration`, or the bulk of CLI traffic is miscounted as `api`. (Verified
 * against firecrawl/cli.)
 */
function originToSurface(
  origin?: string | null,
  integration?: string | null,
): RequestSurface {
  const o = (origin ?? "").toLowerCase();
  const i = (integration ?? "").toLowerCase();
  if (i === "cli" || o === "cli") return "cli";
  if (o === "website" || o.includes("playground")) return "playground";
  if (o.startsWith("mcp")) return "mcp";
  if (o.includes("sdk")) return "sdk"; // e.g. "api-sdk", "js-sdk@x"
  if (o.startsWith("monitor")) return "monitor";
  if (o === "api") return "api";
  return "other";
}

/**
 * Resolve the PostHog distinct_id for a request. firecrawl-web identifies
 * persons by email (`posthog.identify(user.email)`), so to attribute backend
 * events to the same person we key on the API key owner's email. Falls back to
 * the team_id (team-level) when the owner/email can't be resolved.
 *
 * Only called on rare, deduplicated events, so the extra read is cheap.
 */
async function resolveDistinctId(
  teamId: string,
  apiKeyId?: string | number | null,
): Promise<string> {
  if (!apiKeyId) return teamId;
  try {
    const rows = await dbRr
      .select({ email: schema.users.email })
      .from(schema.api_keys)
      .leftJoin(schema.users, eq(schema.users.id, schema.api_keys.owner_id))
      // Scope to the team so a stale/mismatched apiKeyId can't attribute this
      // team's milestone to another team's owner email — falls back to teamId.
      .where(
        and(
          // Compared as text cast to bigint, so an id past the safe-integer
          // range (passed as its exact decimal string) is matched exactly.
          sql`${schema.api_keys.id} = cast(${String(apiKeyId)} as bigint)`,
          eq(schema.api_keys.team_id, teamId),
        ),
      )
      .limit(1);
    return rows[0]?.email || teamId;
  } catch {
    return teamId;
  }
}

/** The org a team belongs to, for the PostHog `company` ($group_0) group. */
async function resolveOrgId(teamId: string): Promise<string | null> {
  try {
    const rows = await dbRr
      .select({ orgId: schema.teams.org_id })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
      .limit(1);
    return rows[0]?.orgId ?? null;
  } catch {
    return null;
  }
}

const SEEN_CACHE_MAX = 200_000;
const seenPairs = new Set<string>();

/**
 * Emit a one-time `api_surface_first_used` event the first time a team makes a
 * request from a given surface (playground / sdk / mcp / cli / api / ...).
 *
 * Dedup is a row in `api_surface_first_uses`: the event is sent only by the
 * call whose INSERT created the row. An in-process cache of seen pairs keeps
 * most requests off the DB. Fails open: a DB error skips the event and is
 * retried on a later request; a rejected capture is not retried.
 *
 * Fire-and-forget: never awaited in the request path, never throws.
 */
export function trackFirstSurfaceUse(args: {
  teamId: string;
  origin?: string | null;
  integration?: string | null;
  kind: string;
  apiVersion: string;
  apiKeyId?: number | null;
}): void {
  const { teamId, origin, integration, kind, apiVersion, apiKeyId } = args;

  if (!isPostHogCaptureEnabled()) return;

  // Skip anonymous / preview traffic — not a real team milestone.
  if (!teamId || teamId === "preview" || teamId.startsWith("preview_")) return;

  const surface = originToSurface(origin, integration);
  const pair = `${teamId}:${surface}`;
  if (seenPairs.has(pair)) return;

  void (async () => {
    try {
      const inserted = await db
        .insert(schema.api_surface_first_uses)
        .values({ team_id: teamId, surface })
        .onConflictDoNothing()
        .returning({ team_id: schema.api_surface_first_uses.team_id });

      if (seenPairs.size >= SEEN_CACHE_MAX) seenPairs.clear();
      seenPairs.add(pair);
      if (inserted.length === 0) return;

      // Key to the person (api-key owner email) so the event attributes to the
      // same PostHog person the dashboard identifies, e.g. for experiments.
      const [distinctId, orgId] = await Promise.all([
        resolveDistinctId(teamId, apiKeyId),
        resolveOrgId(teamId),
      ]);

      await capturePostHog("api_surface_first_used", distinctId, {
        surface,
        raw_origin: origin ?? null,
        raw_integration: integration ?? null,
        kind,
        api_version: apiVersion,
        team_id: teamId,
        // Associate with the PostHog `team` ($group_1) and, when resolvable, the
        // `company` ($group_0) groups for group-level analysis.
        $groups: { team: teamId, ...(orgId ? { company: orgId } : {}) },
      });
    } catch (error) {
      _logger.debug("trackFirstSurfaceUse failed", {
        module: "posthog",
        teamId,
        error,
      });
    }
  })();
}
