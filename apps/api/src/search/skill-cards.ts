import { z } from "zod";
import type { Logger } from "winston";
import { exchangeRequest } from "../services/alexandria/client";

const SKILLS_SOURCE = "skills";
/** Exchange default and maximum this search asks for. The search `limit` is not forwarded. */
const SKILLS_DISCOVERY_LIMIT = 3;
/** Kept short so a slow catalogue lookup cannot hold the rest of the search. */
export const SKILLS_DISCOVERY_TIMEOUT_MS = 3000;
const MAX_QUERY_CHARS = 2000;

export const isSkillsSource = (source: { type: string }) =>
  source.type === SKILLS_SOURCE;

const skillCardSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  source: z.enum(["official", "provider"]),
  provider: z
    .string()
    .nullish()
    .transform(value => (value ? value : undefined)),
  similarity: z.number().finite().nullish(),
});

export type SkillCard = {
  id: string;
  name: string;
  description: string;
  source: "official" | "provider";
  provider?: string;
  similarity?: number;
};

export type SkillDiscovery = {
  skills: SkillCard[];
  /** True only when Exchange returned the skill-card envelope. */
  succeeded: boolean;
};

function missed(): SkillDiscovery {
  return { skills: [], succeeded: false };
}

function toCard(value: z.infer<typeof skillCardSchema>): SkillCard {
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    source: value.source,
    ...(value.provider ? { provider: value.provider } : {}),
    ...(typeof value.similarity === "number"
      ? { similarity: value.similarity }
      : {}),
  };
}

/**
 * Short skill cards for a search query. Failures, including timeouts and a
 * missing Exchange, resolve to an empty list so the rest of the search can
 * still succeed. `succeeded` is false for those paths and for a query that
 * is empty or longer than Exchange accepts. Only the query is sent.
 */
export async function discoverSkills(
  input: {
    teamId: string;
    query: string;
    timeoutMs: number;
    /** The team may only be served by US-based providers. */
    usOnly?: boolean;
  },
  logger: Logger,
): Promise<SkillDiscovery> {
  const query = input.query.trim();
  if (!query || query.length > MAX_QUERY_CHARS) return missed();
  const params = new URLSearchParams({
    q: query,
    limit: String(SKILLS_DISCOVERY_LIMIT),
  });
  try {
    const result = await exchangeRequest({
      teamId: input.teamId,
      // Skill cards. /v1/discover/skills is a different, older route.
      path: `/v1/discover/skill-cards?${params.toString()}`,
      timeoutMs: Math.max(
        1,
        Math.min(input.timeoutMs, SKILLS_DISCOVERY_TIMEOUT_MS),
      ),
      usOnly: input.usOnly === true,
    });
    if (result.status !== 200) {
      logger.warn("Skill discovery unavailable", { status: result.status });
      return missed();
    }
    const parsed = z
      .object({
        query: z.string(),
        skills: z.array(z.unknown()),
      })
      .safeParse(result.body);
    if (!parsed.success) {
      logger.warn("Skill discovery returned an unexpected body");
      return missed();
    }
    const cards: SkillCard[] = [];
    let dropped = 0;
    for (const item of parsed.data.skills) {
      const card = skillCardSchema.safeParse(item);
      if (!card.success) {
        dropped++;
        continue;
      }
      cards.push(toCard(card.data));
      if (cards.length >= SKILLS_DISCOVERY_LIMIT) break;
    }
    if (dropped)
      logger.warn("Skill discovery dropped invalid cards", { dropped });
    return { skills: cards, succeeded: true };
  } catch (error) {
    logger.warn("Skill discovery failed", { error });
    return missed();
  }
}
