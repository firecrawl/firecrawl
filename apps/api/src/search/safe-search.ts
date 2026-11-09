import { noul, type JsonValue } from "@typesafe-ai/sdk";
import type { Logger } from "winston";
import type { SearchV2Response } from "../lib/entities";
import { getTypeSafeClient } from "../lib/typesafe";
import { setSpanAttributes, SpanKind, withSpan } from "../lib/otel-tracer";

/**
 * Jev's probability that a result is adult content, above which it is dropped.
 * Labeled adult results scored 0.42 and up, safe ones 0.04 and below.
 */
const EXPLICIT_THRESHOLD = 0.3;

/** Most Jev calls in flight at once for one result type. */
const MAX_CONCURRENT_JUDGMENTS = 20;

/** Past this, results not yet judged are kept rather than delaying the search. */
const FILTER_BUDGET_MS = 5000;

/** Some providers return page markdown as the snippet; Jev only needs the start. */
const MAX_FIELD_CHARS = 500;

const clip = (text: string | undefined): string | null =>
  text ? text.slice(0, MAX_FIELD_CHARS) : null;

const questions = {
  explicit: noul(
    {
      task: "`result` is one result a web search returned. Is the result adult content, or does it mention an adult content platform?",
      guidance:
        "Judge the result's own title, snippet and URL. Any mention of an adult content platform counts, in any context, including news, business, software, tax or creator advice.",
    },
    {
      true: "Pornographic or sexually explicit material; NSFW or sex AI generators and chat; escorting or camming; or any mention of an adult content platform or adult creator subscription site such as OnlyFans, Fansly, ManyVids, Chaturbate or Pornhub, including guides, comparisons, clones and news about them.",
      false:
        "Anything else, including sex education, sexual health and medicine, dating, fashion, and uses of 'adult' that mean grown-up, such as adult education or adult ADHD.",
    },
  ),
};

/**
 * Drops web, news and image results Jev judges to be adult content, keeping up
 * to `limit` of each in their original order. A result Jev fails to judge is
 * kept, so an outage or slow judgment falls back to the search provider's own
 * safe search.
 */
export async function removeExplicitResults(
  response: SearchV2Response,
  limit: number,
  logger: Logger,
  teamId?: string,
): Promise<void> {
  const { web, news, images } = response;
  if (!web?.length && !news?.length && !images?.length) return;

  const typesafe = getTypeSafeClient();
  if (!typesafe) return;

  await withSpan(
    "search.safe_filter",
    async span => {
      const signal = AbortSignal.timeout(FILTER_BUDGET_MS);
      let judged = 0;
      let dropped = 0;
      let failed = 0;
      let lastError: unknown;

      const isExplicit = async (
        type: string,
        result: Record<string, JsonValue>,
      ): Promise<boolean> => {
        judged++;
        try {
          return await withSpan(
            "typesafe.systemone",
            async callSpan => {
              const { model, answers, usage } = await typesafe.systemOne(
                { state: { result }, questions },
                { signal, timeout: 2000, retry: { maxRetries: 1 } },
              );
              setSpanAttributes(callSpan, {
                "typesafe.model": model,
                // Read by the LLM spend dashboard to price the call.
                "typesafe.usage.input_tokens": usage?.input_tokens,
                "typesafe.usage.output_tokens": usage?.output_tokens,
                "search.safe_filter.explicit_probability":
                  answers.explicit.noul,
              });
              return answers.explicit.noul > EXPLICIT_THRESHOLD;
            },
            {
              kind: SpanKind.CLIENT,
              attributes: {
                "search.safe_filter.result_type": type,
                ...(teamId ? { teamId } : {}),
              },
            },
          );
        } catch (error) {
          failed++;
          lastError = error;
          return false;
        }
      };

      // Judges only as many results as can still be returned, then backfills
      // from the provider's surplus for each one dropped.
      const keepSafe = async <T>(
        type: string,
        items: T[],
        describe: (item: T) => Record<string, JsonValue>,
      ): Promise<T[]> => {
        const kept: T[] = [];
        let next = 0;
        while (kept.length < limit && next < items.length) {
          const batch = items.slice(
            next,
            next + Math.min(limit - kept.length, MAX_CONCURRENT_JUDGMENTS),
          );
          next += batch.length;
          const verdicts = await Promise.all(
            batch.map(item => isExplicit(type, describe(item))),
          );
          batch.forEach((item, index) => {
            if (verdicts[index]) dropped++;
            else kept.push(item);
          });
        }
        return kept;
      };

      const [safeWeb, safeNews, safeImages] = await Promise.all([
        web &&
          keepSafe("web", web, result => ({
            title: clip(result.title),
            snippet: clip(result.description),
            url: clip(result.url),
          })),
        news &&
          keepSafe("news", news, result => ({
            title: clip(result.title),
            snippet: clip(result.snippet),
            url: clip(result.url),
          })),
        images &&
          keepSafe("images", images, result => ({
            title: clip(result.title),
            url: clip(result.url),
            imageUrl: clip(result.imageUrl),
          })),
      ]);
      if (safeWeb) response.web = safeWeb;
      if (safeNews) response.news = safeNews;
      if (safeImages) response.images = safeImages;

      setSpanAttributes(span, {
        "search.safe_filter.judged": judged,
        "search.safe_filter.dropped": dropped,
        "search.safe_filter.failed": failed,
      });
      logger.info("Safe search filter applied", { judged, dropped, failed });
      if (failed > 0) {
        logger.warn("Safe search filter kept results Jev could not judge", {
          failed,
          error: lastError,
        });
      }
    },
    { attributes: { "search.safe_filter.limit": limit } },
  );
}
