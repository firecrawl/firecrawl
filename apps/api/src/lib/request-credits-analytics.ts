import { clickhouseClient } from "./clickhouse-client";
import { setSpanAttributes, withSpan } from "./otel-tracer";

/**
 * Credits billed under a request, summed from the `scrapes_by_request` copy
 * of the scrape job log in the analytics ClickHouse service.
 *
 * The Bigtable request-credits row is the primary source. It only exists for
 * requests started after that store went live, so crawls and batch scrapes
 * from before then have nothing there and this sum is what answers for them.
 * ClickPipes lands a scrape row about a second after the worker logs it, and
 * `FINAL` collapses any redelivered copy, so the sum matches what the job log
 * recorded.
 *
 * A request with no scrape rows yet has been billed nothing, so that is 0,
 * the same answer the PostgreSQL sum gave (COALESCE(SUM, 0)). Only an
 * unconfigured ClickHouse client yields null, meaning "unknown".
 */
export async function readRequestCreditsFromAnalytics(
  requestId: string,
): Promise<number | null> {
  const client = clickhouseClient;
  if (client === null) return null;

  return withSpan("clickhouse.request_credits.read", async span => {
    setSpanAttributes(span, {
      "db.system": "clickhouse",
      "db.collection.name": "scrapes_by_request",
      "request_credits.request_id": requestId,
    });
    const result = await client.query({
      query:
        "SELECT sum(credits_cost) AS credits, count() AS jobs FROM scrapes_by_request FINAL WHERE request_id = {requestId: UUID}",
      query_params: { requestId },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{
      credits: number | string;
      jobs: number | string;
    }>();
    const jobs = Number(row?.jobs ?? 0);
    if (!Number.isFinite(jobs) || jobs === 0) {
      setSpanAttributes(span, {
        "request_credits.outcome": "no_jobs",
        "request_credits.total": 0,
      });
      return 0;
    }
    const credits = Number(row.credits);
    if (!Number.isSafeInteger(credits)) {
      throw new Error(`Invalid analytics credits total: ${row.credits}`);
    }
    setSpanAttributes(span, {
      "request_credits.outcome": "found",
      "request_credits.jobs": jobs,
      "request_credits.total": credits,
    });
    return credits;
  });
}
