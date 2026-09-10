import { fetch } from "undici";
import { z } from "zod";
import { config } from "../../config";
import type { SearchV2Response } from "../../lib/entities";

const responseSchema = z.object({
  skills: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string(),
        matchedDomains: z.array(z.string()),
        url: z.string(),
      }),
    )
    .max(500),
});

export async function resolveSearchSkills(
  data: SearchV2Response,
  teamId: string,
  hasExtendedCatalogAccess = false,
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
  if (!urls.length) return [];
  const base = config.FIRE_EXCHANGE_URL;
  if (!base) throw new Error("Skills unavailable");
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += 100)
    batches.push(urls.slice(index, index + 100));
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
            "x-exchange-extended-catalog-access": String(
              hasExtendedCatalogAccess === true,
            ),
          },
          body: JSON.stringify({ urls }),
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
      ...skill,
      matchedDomains: [
        ...new Set([
          ...(previous?.matchedDomains ?? []),
          ...skill.matchedDomains,
        ]),
      ],
    });
  }
  return [...unique.values()].map(skill => ({
    ...skill,
    url: `https://api.firecrawl.dev/exchange/skills/${encodeURIComponent(skill.id)}/SKILL.md`,
  }));
}
