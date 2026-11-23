import { z } from "zod";
import { exchangeRequest } from "./client";

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 1_000;
const cache = new Map<string, { at: number; types: Map<string, string> }>();

const lookupSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(
      z
        .object({
          provider: z.string(),
          capability: z.string(),
          options: z
            .array(
              z
                .object({
                  name: z.string(),
                  type: z.string(),
                  aliases: z.array(z.string()).optional().catch(undefined),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
  }),
});

/**
 * Declared option types for one capability, from the free find-tools catalogue
 * lookup. Cached per team, since connector capabilities are team-specific. An
 * unknown capability answers an empty map; the call itself then reports it.
 */
export async function capabilityOptionTypes(input: {
  teamId: string;
  provider: string;
  capability: string;
  connectors: boolean;
  timeoutMs: number;
}): Promise<Map<string, string>> {
  const key = `${input.teamId}|${input.connectors}|${input.provider}/${input.capability}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.types;

  const result = await exchangeRequest({
    teamId: input.teamId,
    path: "/v1/retrieve",
    timeoutMs: input.timeoutMs,
    maximumCredits: 0,
    connectors: input.connectors,
    retryConnection: true,
    body: {
      provider: "firecrawl",
      capability: "find-tools",
      options: {
        providers: [input.provider],
        capabilities: [input.capability],
        level: "tools",
        expand: ["options"],
        limit: 1,
      },
    },
  });
  if (result.status !== 200)
    throw new Error(`Contract lookup failed (${result.status})`);
  const items = lookupSchema.parse(result.body).data.items;
  // A provider alias answers under its canonical slug, as the only item.
  const tool =
    items.find(
      item =>
        item.provider === input.provider &&
        item.capability === input.capability,
    ) ??
    (items.length === 1 && items[0].capability === input.capability
      ? items[0]
      : undefined);
  const types = new Map(
    (tool?.options ?? []).flatMap(option =>
      [option.name, ...(option.aliases ?? [])].map(
        name => [name, option.type] as const,
      ),
    ),
  );
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), types });
  return types;
}

export const clearOptionTypeCache = () => cache.clear();
