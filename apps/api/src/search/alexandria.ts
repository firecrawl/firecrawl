import { z } from "zod";
import type { Logger } from "winston";
import { exchangeRequest } from "../services/alexandria/client";
import {
  toolSchema,
  toolSummarySchema,
  type DiscoveredTool,
  type DetailedDiscoveredTool,
} from "../services/alexandria/contracts";

export const isAlexandriaSource = (source: { type: string }) =>
  source.type === "alexandria";
type ToolDiscovery = {
  items: DiscoveredTool[];
  warning?: string;
  /** Every discovery leg failed and nothing was found. */
  unavailable?: true;
};

type SourceLike = string | { type: string };
type CategoryLike = string | { type: string };

const typeOf = (value: SourceLike | CategoryLike) =>
  typeof value === "string" ? value : value?.type;

export function isToolsOnlySearch(
  sources: unknown,
  categories: unknown,
): boolean {
  if (!Array.isArray(sources) || sources.length === 0) return false;
  if (!sources.every(source => typeOf(source) === "alexandria")) return false;
  if (
    Array.isArray(categories) &&
    categories.some(category => {
      const type = typeOf(category);
      return type === "developer" || type === "gov";
    })
  )
    return false;
  return true;
}

export async function discoverTools(
  input: {
    teamId: string;
    toolDetail?: "compact" | "summary" | "full";
    /** Semantic queries, best first; their results are interleaved by rank. */
    queries?: string[];
    /** May still be pending; the semantic lookup starts without waiting for it. */
    urls?: string[] | Promise<string[]>;
    limit: number;
    timeoutMs: number;
    /** The team may use its own MCP connectors: their listed tools join its discovery. */
    connectors?: boolean;
  },
  logger: Logger,
): Promise<ToolDiscovery> {
  const budget = () => Date.now() + Math.min(10000, input.timeoutMs);
  const items = new Map<string, DetailedDiscoveredTool>();
  const selected = { semantic: new Set<string>(), domain: new Set<string>() };
  let attempted = 0;
  let answered = 0;
  const remaining = (deadline: number) => {
    if (Date.now() >= deadline) throw new Error("Tool discovery timed out");
    return deadline - Date.now();
  };
  const lookup = async (options: Record<string, unknown>, deadline: number) => {
    const result = await exchangeRequest({
      teamId: input.teamId,
      path: "/v1/retrieve",
      timeoutMs: remaining(deadline),
      maximumCredits: 0,
      connectors: input.connectors === true,
      body: {
        provider: "firecrawl",
        capability: "find-tools",
        options: {
          ...options,
          level: "tools",
          expand:
            input.toolDetail === "full"
              ? ["options", "response", "examples"]
              : [],
          limit: Math.min(input.limit, 24),
        },
      },
    });
    if (result.status !== 200)
      throw new Error("Tool contract lookup unavailable");
    return z
      .object({
        success: z.literal(true),
        creditsCost: z.literal(0),
        data: z.object({
          items: z.array(
            input.toolDetail === "full" ? toolSchema : toolSummarySchema,
          ),
        }),
      })
      .parse(result.body).data.items;
  };
  const merge = (
    tool: z.infer<typeof toolSchema> | z.infer<typeof toolSummarySchema>,
    source: "semantic" | "domain",
    urls: string[] = [],
  ) => {
    const id = `${tool.provider}/${tool.capability}`;
    const previous = items.get(id);
    if (
      !selected[source].has(id) &&
      selected[source].size >= Math.min(input.limit, 24)
    )
      return;
    selected[source].add(id);
    if (previous) {
      items.set(id, {
        ...previous,
        matchedBy: [...new Set([...(previous.matchedBy ?? []), source])],
        matchedUrls: [...new Set([...(previous.matchedUrls ?? []), ...urls])],
      });
    } else {
      items.set(id, {
        ...tool,
        id,
        matchedBy: [source],
        matchedUrls: [...new Set(urls)],
      });
    }
  };
  const leg = async <T>(
    message: string,
    deadline: number,
    run: () => Promise<T>,
  ): Promise<T | undefined> => {
    attempted++;
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await run();
        answered++;
        return value;
      } catch (error) {
        logger.warn(message, { error, attempt });
        if (attempt >= 2 || Date.now() >= deadline) return undefined;
      }
    }
  };
  const queries = [...new Set(input.queries ?? [])];
  const semanticDeadline = budget();
  const semantic = queries.length
    ? leg("Semantic tool discovery unavailable", semanticDeadline, async () => {
        const settled = await Promise.allSettled(
          queries.map(query => lookup({ query }, semanticDeadline)),
        );
        const lists = settled.flatMap(result =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (!lists.length) throw (settled[0] as PromiseRejectedResult).reason;
        const depth = Math.max(...lists.map(list => list.length));
        const ordered: (typeof lists)[number] = [];
        for (let rank = 0; rank < depth; rank++)
          for (const list of lists) if (list[rank]) ordered.push(list[rank]);
        return ordered;
      })
    : undefined;
  const domain = (async () => {
    const urls = [...new Set((await input.urls) ?? [])].filter(value => {
      const url = URL.parse(value);
      return (
        url &&
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        value.length <= 8192
      );
    });
    if (!urls.length) return undefined;
    // The domain budget starts once the URLs exist, not while the web search runs.
    const deadline = budget();
    // Kept across retries so one failing provider does not discard the others.
    const found: {
      tool: z.infer<typeof toolSchema> | z.infer<typeof toolSummarySchema>;
      urls: string[];
    }[] = [];
    await leg("Domain tool discovery unavailable", deadline, async () => {
      // Resolve domains once; Exchange owns matching and provider visibility.
      for (let i = 0; i < urls.length; i += 100) {
        const batch = urls.slice(i, i + 100);
        const result = await exchangeRequest({
          teamId: input.teamId,
          path: "/v1/skills/resolve",
          body: { urls: batch },
          timeoutMs: remaining(deadline),
          connectors: input.connectors === true,
        });
        if (result.status !== 200)
          throw new Error("Domain discovery unavailable");
        const matches = z
          .object({
            skills: z.array(
              z.object({
                id: z.string(),
                matchedDomains: z.array(z.string()),
                domainCapabilities: z
                  .record(z.string(), z.array(z.string()))
                  .optional(),
              }),
            ),
          })
          .parse(result.body).skills;
        const hostOf = (value: string) =>
          new URL(value).hostname.toLowerCase().replace(/\.$/, "");
        const settled = await Promise.allSettled(
          matches.map(async match => {
            const matchedUrls = batch.filter(value => {
              const host = hostOf(value);
              return (
                match.matchedDomains.includes(host) ||
                match.matchedDomains.includes(host.replace(/^www\./, ""))
              );
            });
            const capabilitiesFor = (url: string) => {
              const host = hostOf(url);
              return [
                ...new Set([
                  ...(match.domainCapabilities?.[url] ?? []),
                  ...(match.domainCapabilities?.[host] ?? []),
                  ...(match.domainCapabilities?.[host.replace(/^www\./, "")] ??
                    []),
                ]),
              ];
            };
            const capabilities = [
              ...new Set(matchedUrls.flatMap(capabilitiesFor)),
            ];
            if (
              !matchedUrls.length ||
              (match.domainCapabilities && !capabilities.length)
            )
              return [];
            const tools = await lookup(
              {
                providers: [match.id],
                ...(capabilities.length ? { capabilities } : {}),
              },
              deadline,
            );
            return tools
              .filter(tool => tool.provider === match.id)
              .map(tool => ({
                tool,
                urls: match.domainCapabilities
                  ? matchedUrls.filter(url =>
                      capabilitiesFor(url).includes(tool.capability),
                    )
                  : matchedUrls,
              }));
          }),
        );
        for (const list of settled)
          if (list.status === "fulfilled") found.push(...list.value);
        const failed = settled.find(list => list.status === "rejected");
        if (failed) throw failed.reason;
      }
    });
    return found;
  })();
  const [semanticTools, domainTools] = await Promise.all([semantic, domain]);
  for (const tool of semanticTools ?? []) merge(tool, "semantic");
  for (const { tool, urls } of domainTools ?? []) merge(tool, "domain", urls);
  return {
    items: [...items.values()].map(tool =>
      input.toolDetail === "compact"
        ? {
            provider: tool.provider,
            capability: tool.capability,
            description: tool.description,
          }
        : tool,
    ),
    ...(answered < attempted
      ? { warning: "Some tool discovery results are unavailable." }
      : {}),
    ...(attempted && !answered && !items.size
      ? { unavailable: true as const }
      : {}),
  };
}
