import { z } from "zod";
import type { Logger } from "winston";
import { exchangeRequest } from "../services/alexandria/client";
import {
  toolSchema,
  type DiscoveredTool,
} from "../services/alexandria/contracts";

export const isAlexandriaSource = (source: { type: string }) =>
  source.type === "alexandria";
type ToolDiscovery = {
  items: DiscoveredTool[];
  warning?: string;
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
    categories.some(category => typeOf(category) === "developer")
  )
    return false;
  return true;
}

export async function discoverTools(
  input: {
    teamId: string;
    query?: string;
    urls?: string[];
    limit: number;
    timeoutMs: number;
  },
  logger: Logger,
): Promise<ToolDiscovery> {
  const deadline = Date.now() + Math.min(10000, input.timeoutMs);
  const items = new Map<string, DiscoveredTool>();
  const selected = { semantic: new Set<string>(), domain: new Set<string>() };
  let failed = false;
  const remaining = () => {
    if (Date.now() >= deadline) throw new Error("Tool discovery timed out");
    return deadline - Date.now();
  };
  const lookup = async (options: Record<string, unknown>) => {
    const result = await exchangeRequest({
      teamId: input.teamId,
      path: "/v1/retrieve",
      timeoutMs: remaining(),
      maximumCredits: 0,
      body: {
        provider: "firecrawl",
        capability: "find-tools",
        options: {
          ...options,
          level: "tools",
          expand: ["options", "response", "examples"],
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
        data: z.object({ items: z.array(toolSchema) }),
      })
      .parse(result.body).data.items;
  };
  const merge = (
    tool: z.infer<typeof toolSchema>,
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
  if (input.query) {
    try {
      const result = await exchangeRequest({
        teamId: input.teamId,
        path: `/v1/discover?q=${encodeURIComponent(input.query)}&limit=${Math.min(input.limit, 24)}`,
        timeoutMs: remaining(),
      });
      if (result.status !== 200)
        throw new Error("Semantic discovery unavailable");
      const hits = z
        .object({
          capabilities: z.array(
            z.object({
              provider: z.string(),
              address: z.string(),
              cohorts: z.array(z.string()).default([]),
            }),
          ),
        })
        .parse(result.body)
        .capabilities.slice(0, Math.min(input.limit, 24));
      // Four concurrent contract lookups, preserving semantic rank.
      for (let i = 0; i < hits.length; i += 4) {
        const contracts = await Promise.all(
          hits.slice(i, i + 4).map(async hit => {
            try {
              if (!hit.cohorts.length)
                return (
                  await lookup({
                    providers: [hit.provider],
                    capabilities: [hit.address],
                  })
                )[0];
              const parts = [
                hit.cohorts[0],
                hit.provider,
                ...hit.address.split("/"),
              ];
              if (
                parts.some(part => !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part))
              )
                throw new Error("Invalid tool identifier");
              const contract = await exchangeRequest({
                teamId: input.teamId,
                path: `/v1/discover/${parts.map(encodeURIComponent).join("/")}`,
                timeoutMs: remaining(),
              });
              if (contract.status !== 200)
                throw new Error("Tool contract unavailable");
              const body = z
                .object({
                  label: z.string(),
                  whenToUse: z.string(),
                  returns: z.unknown(),
                })
                .passthrough()
                .parse(contract.body);
              const tool = toolSchema.parse({
                ...body,
                name: body.label,
                description: body.whenToUse,
                response: body.returns,
              });
              if (
                tool.provider !== hit.provider ||
                tool.capability !== hit.address
              )
                throw new Error("Tool identity mismatch");
              return tool;
            } catch {
              failed = true;
              return undefined;
            }
          }),
        );
        for (const tool of contracts) if (tool) merge(tool, "semantic");
      }
    } catch (error) {
      failed = true;
      logger.warn("Semantic tool discovery unavailable", { error });
    }
  }
  const urls = [...new Set(input.urls ?? [])].filter(value => {
    const url = URL.parse(value);
    return (
      url &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      value.length <= 8192
    );
  });
  if (urls.length) {
    try {
      // Resolve domains once; Exchange owns matching and provider visibility.
      for (let i = 0; i < urls.length; i += 100) {
        const result = await exchangeRequest({
          teamId: input.teamId,
          path: "/v1/skills/resolve",
          body: { urls: urls.slice(i, i + 100) },
          timeoutMs: remaining(),
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
        for (const match of matches) {
          const matchedUrls = urls.slice(i, i + 100).filter(value => {
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
            continue;
          for (const tool of await lookup({
            providers: [match.id],
            ...(capabilities.length ? { capabilities } : {}),
          }))
            if (tool.provider === match.id)
              merge(
                tool,
                "domain",
                match.domainCapabilities
                  ? matchedUrls.filter(url =>
                      capabilitiesFor(url).includes(tool.capability),
                    )
                  : matchedUrls,
              );
        }
      }
    } catch (error) {
      failed = true;
      logger.warn("Domain tool discovery unavailable", { error });
    }
  }
  return {
    items: [...items.values()],
    ...(failed
      ? { warning: "Some tool discovery results are unavailable." }
      : {}),
  };
}
