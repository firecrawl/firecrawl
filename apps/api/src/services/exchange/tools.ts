import {
  loadToolContract,
  type DiscoveredTool,
} from "../../search/alexandria-source";
import { forwardToExchange } from "../../lib/exchange-proxy";
import { z } from "zod";
import { config } from "../../config";
import type { SearchV2Response } from "../../lib/entities";

const responseSchema = z.object({
  skills: z
    .array(
      z.object({
        id: z.string().min(1),
        matchedDomains: z.array(z.string()),
        domainCapabilities: z
          .record(z.string(), z.array(z.string()))
          .optional(),
      }),
    )
    .max(500),
});
type DomainMatch = z.infer<typeof responseSchema>["skills"][number];
type DomainDiscoveryInput = {
  data: SearchV2Response;
  teamId: string;
  hasExtendedCatalogAccess: boolean;
  requestId: string;
  timeoutMs: number;
  limit: number;
};

function resultUrls(data: SearchV2Response): string[] {
  return [
    ...new Set(
      [...(data.web ?? []), ...(data.news ?? []), ...(data.images ?? [])]
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
}

async function resolveDomainMatches(
  input: DomainDiscoveryInput,
  urls: string[],
  remaining: () => number,
): Promise<DomainMatch[]> {
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += 100)
    batches.push(urls.slice(index, index + 100));
  const results = await Promise.all(
    batches.map(async urls => {
      const response = await forwardToExchange({
        teamId: input.teamId,
        hasExtendedCatalogAccess: input.hasExtendedCatalogAccess,
        requestId: input.requestId,
        method: "POST",
        path: "/v1/skills/resolve",
        body: { urls },
        timeoutMs: remaining(),
      });
      if (response.status !== 200)
        throw new Error("Domain discovery unavailable");
      return responseSchema.parse(response.body).skills;
    }),
  );
  const unique = new Map<string, DomainMatch>();
  for (const group of results.flat()) {
    const previous = unique.get(group.id);
    if (!previous) {
      unique.set(group.id, group);
      continue;
    }
    previous.matchedDomains = [
      ...new Set([...previous.matchedDomains, ...group.matchedDomains]),
    ];
    for (const [domain, capabilities] of Object.entries(
      group.domainCapabilities ?? {},
    )) {
      previous.domainCapabilities ??= {};
      previous.domainCapabilities[domain] = [
        ...new Set([
          ...(previous.domainCapabilities[domain] ?? []),
          ...capabilities,
        ]),
      ];
    }
  }
  return [...unique.values()];
}

const mappingCache = new Map<
  string,
  { expires: number; groups: DomainMatch[] }
>();

export async function discoverDomainTools(
  input: DomainDiscoveryInput,
): Promise<{ items: DiscoveredTool[]; warning?: string }> {
  const urls = resultUrls(input.data);
  if (!urls.length || input.limit <= 0) return { items: [] };
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
      : await resolveDomainMatches(input, urls, remaining);
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
    if (selected.size >= input.limit) break;
    let domainCapabilities = group.domainCapabilities;
    if (!domainCapabilities) {
      // Older catalogues return provider matches without capability selections.
      try {
        const matchedUrls = urls.filter(url =>
          group.matchedDomains.includes(
            new URL(url).hostname.replace(/\.$/, ""),
          ),
        );
        if (!matchedUrls.length) continue;
        const limit = input.limit - selected.size;
        const lookup = await forwardToExchange({
          teamId: input.teamId,
          hasExtendedCatalogAccess: input.hasExtendedCatalogAccess,
          requestId: input.requestId,
          timeoutMs: remaining(),
          method: "POST",
          path: "/v1/retrieve",
          body: {
            provider: "firecrawl-contextual-discovery",
            capability: "discovery/context",
            options: { providers: [group.id], level: "tools", limit },
          },
        });
        if (lookup.status !== 200)
          throw new Error("Provider catalogue unavailable");
        const result = z
          .object({
            success: z.literal(true),
            creditsCost: z.literal(0),
            data: z.object({
              items: z
                .array(
                  z.object({
                    provider: z.literal(group.id),
                    capability: z.string().min(1),
                  }),
                )
                .max(limit),
            }),
          })
          .parse(lookup.body);
        domainCapabilities = Object.fromEntries(
          matchedUrls.map(url => [
            url,
            result.data.items.map(item => item.capability),
          ]),
        );
      } catch {
        failures++;
        continue;
      }
    }
    for (const url of urls) {
      const hostname = new URL(url).hostname;
      const capabilities = new Set([
        ...(domainCapabilities[url] ?? []),
        ...(domainCapabilities[hostname] ?? []),
        ...(domainCapabilities[hostname.replace(/^www\./, "")] ?? []),
      ]);
      for (const capability of capabilities) {
        const id = JSON.stringify([group.id, capability]);
        if (!selected.has(id) && selected.size < input.limit)
          selected.set(id, { provider: group.id, capability, urls: new Set() });
        selected.get(id)?.urls.add(url);
      }
    }
  }
  const matches = [...selected.values()];
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
