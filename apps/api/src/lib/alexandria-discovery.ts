import { config } from "../config";
import { redisRateLimitClient } from "../services/rate-limiter";
import { logger } from "./logger";

const WINDOW_SECONDS = 3600;
const SOURCES = ["search", "auto_search", "find_tools"] as const;
type DiscoverySource = (typeof SOURCES)[number];
// A library command joins the resolved search only; `discovery` keeps its three sources.
const SEARCH_SOURCES = [...SOURCES, "library"] as const;
type SearchSource = (typeof SEARCH_SOURCES)[number];
type ToolRef = { provider: string; capability: string };
type Lineage = { sessionId?: string; threadId?: string };
export type CallDiscovery = Partial<
  Record<DiscoverySource, { id: string; secondsBefore: number }>
>;
/** The search that most likely led to a call, and how sure the link is. */
export type CallSearch = {
  id: string;
  source: SearchSource;
  rank?: number;
  match: "conversation" | "session" | "team";
  secondsBefore: number;
  requestId?: string;
};

// Best first: the same conversation, the same session, then the same team only.
const scopesOf = (
  lineage: Lineage,
): { match: CallSearch["match"]; key: string[] }[] => [
  ...(lineage.threadId
    ? [{ match: "conversation" as const, key: ["thread", lineage.threadId] }]
    : []),
  ...(lineage.sessionId
    ? [{ match: "session" as const, key: ["session", lineage.sessionId] }]
    : []),
  { match: "team", key: [] },
];

const discoveredKey = (
  source: SearchSource,
  teamId: string,
  tool: ToolRef,
  scope: string[] = [],
) =>
  `alexandria:discovered:${JSON.stringify([source, teamId, tool.provider, tool.capability, ...scope])}`;

const LIBRARY_TOOL_LIMIT = 50;
const LIBRARY_SCAN_CHARS = 200_000;
const SEGMENT = "[A-Za-z0-9._-]{1,100}";
// /library/<category>/<provider>/<capability path>.md
const LIBRARY_CONTRACT = new RegExp(
  `/library/(${SEGMENT})/(${SEGMENT})/((?:${SEGMENT}/){0,8}${SEGMENT})\\.md(?![A-Za-z0-9_/-])`,
  "g",
);

/**
 * The tools whose contracts a library command named or listed, ranked by first
 * appearance: paths in the command, then paths in its output. None while the
 * switch is off.
 */
export function libraryCommandTools(
  command: unknown,
  stdout: unknown,
): (ToolRef & { rank: number })[] {
  if (!config.ALEXANDRIA_SEARCH_CONTEXT_ENABLED) return [];
  const tools = new Map<string, ToolRef & { rank: number }>();
  for (const text of [command, stdout]) {
    if (typeof text !== "string") continue;
    for (const [, category, provider, capability] of text
      .slice(0, LIBRARY_SCAN_CHARS)
      .matchAll(LIBRARY_CONTRACT)) {
      if (category === "skills" || /(^|\/)README$/.test(capability)) continue;
      const id = `${provider}/${capability}`;
      if (tools.has(id)) continue;
      tools.set(id, { provider, capability, rank: tools.size + 1 });
      if (tools.size >= LIBRARY_TOOL_LIMIT) return [...tools.values()];
    }
  }
  return [...tools.values()];
}

/**
 * Remembers for an hour that a search, find-tools or library job showed these
 * tools to the team, and to the conversation and session when known, so a
 * later provider call can be attributed to it. A tool's rank is its position
 * in the list unless given. Never throws or rejects.
 */
export function recordDiscoveredTools(
  teamId: string,
  source: SearchSource,
  jobId: string,
  tools: (ToolRef & { rank?: number })[],
  search: Lineage & { requestId?: string } = {},
): void {
  const enabled = config.ALEXANDRIA_SEARCH_CONTEXT_ENABLED;
  if (!tools.length || (source === "library" && !enabled)) return;
  void (async () => {
    const at = Date.now();
    const scopes = scopesOf(enabled ? search : {});
    const pipeline = redisRateLimitClient.pipeline();
    const seen = new Set<string>();
    tools.forEach((tool, index) => {
      // A tool listed twice keeps the rank of its first appearance.
      const teamKey = discoveredKey(source, teamId, tool);
      if (seen.has(teamKey)) return;
      seen.add(teamKey);
      const value = JSON.stringify({
        id: jobId,
        at,
        ...(enabled ? { rank: tool.rank ?? index + 1 } : {}),
        ...(enabled && search.requestId ? { requestId: search.requestId } : {}),
      });
      for (const scope of scopes)
        pipeline.set(
          discoveredKey(source, teamId, tool, scope.key),
          value,
          "EX",
          WINDOW_SECONDS,
        );
    });
    const results = await pipeline.exec();
    const error = results?.find(([commandError]) => commandError)?.[0];
    if (error) throw error;
  })().catch(error =>
    logger.warn("Failed to record Alexandria discovery", { error, teamId }),
  );
}

/**
 * For each call: the latest search and find-tools jobs in the last hour that
 * showed its tool to the team, and the one search that most likely led to it.
 * One round trip.
 */
export async function discoveryForCalls(
  teamId: string,
  calls: ToolRef[],
  lineage: Lineage = {},
): Promise<{ discovery: CallDiscovery; search?: CallSearch }[]> {
  const enabled = config.ALEXANDRIA_SEARCH_CONTEXT_ENABLED;
  const sources: readonly SearchSource[] = enabled ? SEARCH_SOURCES : SOURCES;
  const scopes = scopesOf(enabled ? lineage : {});
  const values = await redisRateLimitClient.mget(
    calls.flatMap(call =>
      sources.flatMap(source =>
        scopes.map(scope => discoveredKey(source, teamId, call, scope.key)),
      ),
    ),
  );
  const now = Date.now();
  return calls.map((_, i) => {
    const discovery: CallDiscovery = {};
    // The most recent candidate of the best class that has one.
    let best: { scope: number; at: number; search: CallSearch } | undefined;
    for (const [j, source] of sources.entries())
      for (const [k, scope] of scopes.entries()) {
        const value = values[(i * sources.length + j) * scopes.length + k];
        if (!value) continue;
        try {
          const { id, at, rank, requestId } = JSON.parse(value) as Record<
            string,
            unknown
          >;
          if (typeof id !== "string" || typeof at !== "number") continue;
          const secondsBefore = Math.round((now - at) / 1000);
          if (scope.match === "team" && source !== "library")
            discovery[source] = { id, secondsBefore };
          if (
            !enabled ||
            (best && (best.scope < k || (best.scope === k && best.at >= at)))
          )
            continue;
          best = {
            scope: k,
            at,
            search: {
              id,
              source,
              ...(typeof rank === "number" ? { rank } : {}),
              match: scope.match,
              secondsBefore,
              ...(typeof requestId === "string" ? { requestId } : {}),
            },
          };
        } catch {}
      }
    return { discovery, ...(best ? { search: best.search } : {}) };
  });
}
