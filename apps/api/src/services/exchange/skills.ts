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

export async function resolveSearchSkills(
  data: SearchV2Response,
  teamId: string,
  hasExtendedCatalogAccess = false,
  requestId?: string,
  query?: string,
  apiOrigin = "https://api.firecrawl.dev",
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
    return parsed?.protocol === "https:" || parsed?.protocol === "http:";
  });
  const searchQuery = query?.slice(0, 2000).trim();
  if (!urls.length && !searchQuery) return [];
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
          signal: AbortSignal.timeout(5000),
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
