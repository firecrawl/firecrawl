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
 * ClickPipes lands rows about a second after the worker logs them, so a
 * request whose scrapes are still in flight can read as having none. What
 * that means depends on the caller:
 *
 * - a status endpoint answering a customer treats it as 0 (nothing billed
 *   yet), the same answer the PostgreSQL sum gave (COALESCE(SUM, 0));
 * - crawl finalization, which records `credits_cost` for good, treats it as
 *   unknown (null) rather than writing a zero that a second's lag produced.
 *
 * An unconfigured ClickHouse client always yields null.
 */
export async function readRequestCreditsFromAnalytics(
  requestId: string,
  options: { emptyAsZero: boolean },
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
    if (!Number.isSafeInteger(jobs)) {
      throw new Error(`Invalid analytics job count: ${row?.jobs}`);
    }
    if (jobs === 0) {
      setSpanAttributes(span, { "request_credits.outcome": "no_jobs" });
      return options.emptyAsZero ? 0 : null;
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
