import { noul, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import type { Logger } from "winston";
import type { SearchV2Response } from "../lib/entities";
import { config } from "../config";

/** Jev's probability that a result is adult content, above which it is dropped. */
const EXPLICIT_THRESHOLD = 0.5;

const questions = {
  explicit: noul(
    {
      task: "`result` is one result a web search returned for `search_query`. Is the result itself adult sexual content?",
      guidance:
        "Judge the result's own title, snippet and URL. The query only clarifies ambiguous words; a sexual query does not make an unrelated result adult content.",
    },
    {
      true: "Pornographic or sexually explicit material, or a page mainly about adult sexual entertainment: porn sites, NSFW or sex AI generators and chat, escorting, camming, and adult creator or fan subscription platforms.",
      false:
        "Anything else, including sex education, sexual health and medicine, news, law, dating, and fashion that is not sexually explicit.",
    },
  ),
};

let client: TypeSafeClient | undefined;

function getClient(): TypeSafeClient | null {
  if (!config.TYPESAFE_API_KEY) return null;
  client ??= new TypeSafeClient({
    apiKey: config.TYPESAFE_API_KEY,
    timeout: 2000,
    retry: { maxRetries: 1 },
    logLevel: "off",
  });
  return client;
}

/**
 * Drops web, news and image results Jev judges to be adult content, keeping up
 * to `limit` of each in their original order. A result Jev fails to judge is
 * kept, so an outage falls back to the search provider's own safe search.
 */
export async function removeExplicitResults(
  response: SearchV2Response,
  query: string,
  limit: number,
  logger: Logger,
): Promise<void> {
  const typesafe = getClient();
  if (!typesafe) return;

  let judged = 0;
  let dropped = 0;
  let failed = 0;
  let lastError: unknown;

  const isExplicit = async (
    result: Record<string, JsonValue>,
  ): Promise<boolean> => {
    judged++;
    try {
      const { answers } = await typesafe.systemOne({
        state: { search_query: query, result },
        questions,
      });
      return answers.explicit.noul > EXPLICIT_THRESHOLD;
    } catch (error) {
      failed++;
      lastError = error;
      return false;
    }
  };

  // Judges only as many results as can still be returned, then backfills
  // from the provider's surplus for each one dropped.
  const keepSafe = async <T>(
    items: T[],
    describe: (item: T) => Record<string, JsonValue>,
  ): Promise<T[]> => {
    const kept: T[] = [];
    let next = 0;
    while (kept.length < limit && next < items.length) {
      const batch = items.slice(next, next + limit - kept.length);
      next += batch.length;
      const verdicts = await Promise.all(
        batch.map(item => isExplicit(describe(item))),
      );
      batch.forEach((item, index) => {
        if (verdicts[index]) dropped++;
        else kept.push(item);
      });
    }
    return kept;
  };

  const { web, news, images } = response;
  const [safeWeb, safeNews, safeImages] = await Promise.all([
    web &&
      keepSafe(web, result => ({
        title: result.title,
        snippet: result.description,
        url: result.url,
      })),
    news &&
      keepSafe(news, result => ({
        title: result.title ?? null,
        snippet: result.snippet ?? null,
        url: result.url ?? null,
      })),
    images &&
      keepSafe(images, result => ({
        title: result.title ?? null,
        url: result.url ?? null,
        imageUrl: result.imageUrl ?? null,
      })),
  ]);
  if (safeWeb) response.web = safeWeb;
  if (safeNews) response.news = safeNews;
  if (safeImages) response.images = safeImages;

  logger.info("Safe search filter applied", { judged, dropped, failed });
  if (failed > 0) {
    logger.warn("Safe search filter kept results Jev could not judge", {
      failed,
      error: lastError,
    });
  }
}
