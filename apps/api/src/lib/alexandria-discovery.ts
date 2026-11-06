import { redisRateLimitClient } from "../services/rate-limiter";
import { logger } from "./logger";

const WINDOW_SECONDS = 3600;
const SOURCES = ["search", "auto_search", "find_tools"] as const;
type DiscoverySource = (typeof SOURCES)[number];
type ToolRef = { provider: string; capability: string };
export type CallDiscovery = Partial<
  Record<DiscoverySource, { id: string; secondsBefore: number }>
>;

const discoveredKey = (
  source: DiscoverySource,
  teamId: string,
  tool: ToolRef,
) =>
  `alexandria:discovered:${JSON.stringify([source, teamId, tool.provider, tool.capability])}`;

/**
 * Remembers for an hour that a search or find-tools job showed these tools to
 * the team, so a later provider call can be attributed to it. Never rejects.
 */
export function recordDiscoveredTools(
  teamId: string,
  source: DiscoverySource,
  jobId: string,
  tools: ToolRef[],
): void {
  if (!tools.length) return;
  const value = JSON.stringify({ id: jobId, at: Date.now() });
  const pipeline = redisRateLimitClient.pipeline();
  for (const tool of tools)
    pipeline.set(
      discoveredKey(source, teamId, tool),
      value,
      "EX",
      WINDOW_SECONDS,
    );
  pipeline
    .exec()
    .then(results => {
      const error = results?.find(([commandError]) => commandError)?.[0];
      if (error) throw error;
    })
    .catch(error =>
      logger.warn("Failed to record Alexandria discovery", { error, teamId }),
    );
}

/** The latest search and find-tools jobs in the last hour that showed each call's tool to the team. */
export async function discoveryForCalls(
  teamId: string,
  calls: ToolRef[],
): Promise<CallDiscovery[]> {
  const values = await redisRateLimitClient.mget(
    calls.flatMap(call =>
      SOURCES.map(source => discoveredKey(source, teamId, call)),
    ),
  );
  const now = Date.now();
  return calls.map((_, i) =>
    Object.fromEntries(
      SOURCES.flatMap((source, j) => {
        const value = values[i * SOURCES.length + j];
        if (!value) return [];
        try {
          const { id, at } = JSON.parse(value) as { id: string; at: number };
          return [
            [source, { id, secondsBefore: Math.round((now - at) / 1000) }],
          ];
        } catch {
          return [];
        }
      }),
    ),
  );
}
