import {
  loadToolContract,
  type DiscoveredTool,
} from "../../search/alexandria-source";
import { fetch } from "undici";
import { z } from "zod";
import { config } from "../../config";
import type { SearchV2Response } from "../../lib/entities";

const responseSchema = z.object({
  skills: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        origin: z.enum(["api", "crawl"]).optional(),
        toolCount: z.number().int().nonnegative().optional(),
        description: z.string(),
        matchedDomains: z.array(z.string()),
        matchedTerms: z.array(z.string()).optional(),
        domainCapabilities: z
          .record(z.string(), z.array(z.string()))
          .optional(),
        queryCapabilities: z.array(z.string()).optional(),
        url: z.string(),
      }),
    )
    .max(500),
});

export async function resolveSearchTools(
  data: SearchV2Response,
  teamId: string,
  hasExtendedCatalogAccess = false,
  requestId?: string,
  query?: string,
  apiOrigin = "https://api.firecrawl.dev",
  timeoutMs = 5000,
) {
  const urls = [
    ...new Set([
      ...(data.web ?? []).map(result => result.url),
      ...(data.news ?? []).map(result => result.url),
      ...(data.images ?? []).map(result => result.url),
    ]),
  ].filter((url): url is string => {
    if (typeof url !== "string" || url.length > 8192) return false;
    const parsed = URL.parse(url);
    return (
      !!parsed &&
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password
    );
  });
  const searchQuery = query?.slice(0, 2000).trim();
  if (!urls.length && !searchQuery) return [];
  if (timeoutMs <= 0) throw new Error("Skills lookup deadline exceeded");
  const signal = AbortSignal.timeout(Math.min(5000, timeoutMs));
  const base = config.FIRE_EXCHANGE_URL;
  if (!base) throw new Error("Skills unavailable");
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += 100)
    batches.push(urls.slice(index, index + 100));
  if (!batches.length) batches.push([]);
  const results = await Promise.all(
    batches.map(async urls => {
      const response = await fetch(
        `${base.replace(/\/+$/, "")}/v1/skills/resolve`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-exchange-team-id": teamId,
            ...(requestId !== undefined ? { "x-request-id": requestId } : {}),
            "x-exchange-extended-catalog-access": String(
              hasExtendedCatalogAccess === true,
            ),
          },
          body: JSON.stringify({
            urls,
            ...(searchQuery ? { query: searchQuery } : {}),
          }),
          signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Skills unavailable");
      }
      return responseSchema.parse(await response.json()).skills;
    }),
  );
  const unique = new Map<
    string,
    z.infer<typeof responseSchema>["skills"][number]
  >();
  for (const skill of results.flat()) {
    const previous = unique.get(skill.id);
    unique.set(skill.id, {
      ...previous,
      ...skill,
      name: skill.name ?? previous?.name,
      origin: skill.origin ?? previous?.origin,
      toolCount: skill.toolCount ?? previous?.toolCount,
      matchedDomains: [
        ...new Set([
          ...(previous?.matchedDomains ?? []),
          ...skill.matchedDomains,
        ]),
      ],
      ...(skill.matchedTerms || previous?.matchedTerms
        ? {
            matchedTerms: [
              ...new Set([
                ...(previous?.matchedTerms ?? []),
                ...(skill.matchedTerms ?? []),
              ]),
            ],
          }
        : {}),
      ...(skill.domainCapabilities || previous?.domainCapabilities
        ? {
            domainCapabilities: Object.fromEntries(
              [
                ...new Set([
                  ...Object.keys(previous?.domainCapabilities ?? {}),
                  ...Object.keys(skill.domainCapabilities ?? {}),
                ]),
              ].map(domain => [
                domain,
                [
                  ...new Set([
                    ...(previous?.domainCapabilities?.[domain] ?? []),
                    ...(skill.domainCapabilities?.[domain] ?? []),
                  ]),
                ],
              ]),
            ),
          }
        : {}),
      ...(skill.queryCapabilities || previous?.queryCapabilities
        ? {
            queryCapabilities: [
              ...new Set([
                ...(previous?.queryCapabilities ?? []),
                ...(skill.queryCapabilities ?? []),
              ]),
            ],
          }
        : {}),
    });
  }
  return [...unique.values()].map(skill => ({
    ...skill,
    ...(skill.domainCapabilities || skill.queryCapabilities
      ? {
          toolCount: new Set([
            ...Object.values(skill.domainCapabilities ?? {}).flat(),
            ...(skill.queryCapabilities ?? []),
          ]).size,
        }
      : {}),
    url: `${apiOrigin}/exchange/skills/${encodeURIComponent(skill.id)}/SKILL.md`,
  }));
}

const mappingCache = new Map<
  string,
  { expires: number; groups: Awaited<ReturnType<typeof resolveSearchTools>> }
>();

export async function discoverDomainTools(input: {
  data: SearchV2Response;
  teamId: string;
  hasExtendedCatalogAccess: boolean;
  requestId: string;
  timeoutMs: number;
  limit: number;
}): Promise<{ items: DiscoveredTool[]; warning?: string }> {
  const urls = [
    ...new Set(
      [
        ...(input.data.web ?? []),
        ...(input.data.news ?? []),
        ...(input.data.images ?? []),
      ]
        .map(item => item.url)
        .filter((url): url is string => {
          if (typeof url !== "string" || url.length > 8192) return false;
          const parsed = URL.parse(url);
          return (
            !!parsed &&
            ["https:", "http:"].includes(parsed.protocol) &&
            !parsed.username &&
            !parsed.password
          );
        }),
    ),
  ];
  if (!urls.length) return { items: [] };
  const deadline = Date.now() + Math.min(input.timeoutMs, 5000);
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Domain discovery deadline exceeded");
    return ms;
  };
  remaining();
  const key = JSON.stringify([
    config.FIRE_EXCHANGE_URL,
    input.teamId,
    input.hasExtendedCatalogAccess,
    [...urls].sort(),
  ]);
  const cached = mappingCache.get(key);
  const groups =
    cached && cached.expires > Date.now()
      ? cached.groups
      : await resolveSearchTools(
          { web: urls.map(url => ({ url, title: "", description: "" })) },
          input.teamId,
          input.hasExtendedCatalogAccess,
          input.requestId,
          undefined,
          undefined,
          remaining(),
        );
  if (
    (!cached || cached.expires <= Date.now()) &&
    key.length <= 16384 &&
    JSON.stringify(groups).length <= 262144
  ) {
    if (mappingCache.size >= 64)
      mappingCache.delete(mappingCache.keys().next().value!);
    mappingCache.set(key, { expires: Date.now() + 30000, groups });
  }
  const selected = new Map<
    string,
    { provider: string; capability: string; urls: Set<string> }
  >();
  let failures = 0;
  for (const group of groups) {
    if (!group.domainCapabilities) {
      failures++;
      continue;
    }
    for (const url of urls) {
      const hostname = new URL(url).hostname;
      const capabilities = new Set([
        ...(group.domainCapabilities[url] ?? []),
        ...(group.domainCapabilities[hostname] ?? []),
        ...(group.domainCapabilities[hostname.replace(/^www\./, "")] ?? []),
      ]);
      for (const capability of capabilities) {
        const id = JSON.stringify([group.id, capability]);
        if (!selected.has(id))
          selected.set(id, { provider: group.id, capability, urls: new Set() });
        selected.get(id)!.urls.add(url);
      }
    }
  }
  const matches = [...selected.values()].slice(0, input.limit);
  const items: DiscoveredTool[] = new Array(matches.length);
  let position = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, matches.length) }, async () => {
      while (position < matches.length) {
        const index = position++;
        const match = matches[index];
        try {
          const contract = await loadToolContract({
            ...input,
            provider: match.provider,
            capability: match.capability,
            timeoutMs: remaining(),
          });
          items[index] = {
            ...contract,
            matchedBy: ["domain"],
            matchedUrls: [...match.urls],
          };
        } catch {
          failures++;
        }
      }
    }),
  );
  return {
    items: items.filter(Boolean),
    ...(failures
      ? { warning: "Some domain tool contracts could not be loaded." }
      : {}),
  };
}

export function mergeDiscoveredTools(
  ...groups: DiscoveredTool[][]
): DiscoveredTool[] {
  const unique = new Map<string, DiscoveredTool>();
  for (const tool of groups.flat()) {
    const key = JSON.stringify([tool.provider, tool.capability]);
    const previous = unique.get(key);
    unique.set(
      key,
      previous
        ? {
            ...tool,
            ...previous,
            matchedBy: [...new Set([...previous.matchedBy, ...tool.matchedBy])],
            matchedUrls: [
              ...new Set([...previous.matchedUrls, ...tool.matchedUrls]),
            ],
          }
        : {
            ...tool,
            matchedBy: [...tool.matchedBy],
            matchedUrls: [...tool.matchedUrls],
          },
    );
  }
  return [...unique.values()];
}
