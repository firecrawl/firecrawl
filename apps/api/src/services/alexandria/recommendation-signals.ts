import { clickhouseClient } from "../../lib/clickhouse-client";
import { logger as rootLogger } from "../../lib/logger";

const WINDOW_DAYS = 30;
/** With `timeout_overflow_mode: break` this returns what was aggregated so far, not an error. */
const CLICKHOUSE_MAX_SECONDS = 2;
const CLICKHOUSE_TIMEOUT_MS = 3_000;
/** Per endpoint kind: enough hosts and queries to fill the Exchange's lookups. */
const ROWS_PER_KIND = 200;
const HOST_LIMIT = 100;
const SEARCH_LIMIT = 50;
const QUERY_MAX_LENGTH = 200;

/** Kinds whose `target_hint` is the URL the request was about (the first one, for batches). */
const URL_KINDS = ["scrape", "batch_scrape", "crawl", "map", "extract"];
/** What is stored as `target_hint` for zero-data-retention requests, in place of the input. */
const ZDR_TARGET_HINT = "<redacted due to zero data retention>";

const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The team's own activity on the other endpoints, in the shape `/v1/recommendations` takes. */
interface RecommendationSignals {
  hosts: { host: string; requests: number }[];
  searches?: { query: string; requests: number }[];
  kinds: Record<string, number>;
}

function normalizeHost(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  return host.length <= 253 && HOSTNAME.test(host) ? host : null;
}

/**
 * One aggregated read over the team's `requests` for the usage window: hosts it scraped, crawled,
 * mapped or extracted from, requests per kind and, only when `searches` is set, its search
 * queries. Without `searches` no search text is selected; search requests still count per kind.
 * Alexandria calls are left out because the Exchange already knows them per provider. Distinct
 * ids are counted because a redelivered row coexists with the original until parts merge.
 *
 * Never fails: without ClickHouse, or on an error or timeout, the signals are empty and the
 * Exchange ranks from Alexandria usage and the catalogue alone.
 */
export async function teamRecommendationSignals(
  teamId: string,
  options: { searches: boolean },
): Promise<RecommendationSignals> {
  const signals: RecommendationSignals = {
    hosts: [],
    ...(options.searches ? { searches: [] } : {}),
    kinds: {},
  };
  if (clickhouseClient === null) return signals;

  let rows: { kind: string; target: string | null; n: number | string }[];
  try {
    const result = await clickhouseClient.query({
      query: `
        SELECT kind, target, n FROM (
          SELECT
            kind,
            multiIf(
              kind IN {urlKinds: Array(String)}, lower(domainWithoutWWW(target_hint)),
              ${options.searches ? "kind = 'search', trimBoth(target_hint)," : ""}
              ''
            ) AS target,
            toUInt32(uniq(id)) AS n
          FROM requests
          WHERE team_id = {teamId: UUID}
            AND created_at >= {since: DateTime64(3)}
            AND kind != 'alexandria'
            AND NOT startsWith(coalesce(target_hint, ''), 'alexandria:')
            AND NOT startsWith(coalesce(target_hint, ''), {redacted: String})
          GROUP BY kind, target
        )
        ORDER BY n DESC
        LIMIT {rowsPerKind: UInt32} BY kind
      `,
      query_params: {
        teamId,
        since: new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace("T", " ")
          .replace(/Z$/, ""),
        urlKinds: URL_KINDS,
        redacted: ZDR_TARGET_HINT,
        rowsPerKind: ROWS_PER_KIND,
      },
      format: "JSONEachRow",
      clickhouse_settings: {
        max_execution_time: CLICKHOUSE_MAX_SECONDS,
        timeout_overflow_mode: "break",
      },
      abort_signal: AbortSignal.timeout(CLICKHOUSE_TIMEOUT_MS),
    });
    rows = await result.json();
  } catch (error) {
    rootLogger.warn("Recommendation signals unavailable", {
      module: "alexandria/recommendation-signals",
      teamId,
      error: error instanceof Error ? error.message : String(error),
    });
    return signals;
  }

  const hosts = new Map<string, number>();
  for (const { kind, target, n } of rows) {
    const requests = Number(n);
    if (!Number.isFinite(requests) || requests <= 0) continue;
    signals.kinds[kind] = (signals.kinds[kind] ?? 0) + requests;
    if (!target) continue;
    if (kind === "search") {
      if (signals.searches && signals.searches.length < SEARCH_LIMIT) {
        signals.searches.push({
          query: target.slice(0, QUERY_MAX_LENGTH),
          requests,
        });
      }
      continue;
    }
    const host = normalizeHost(target);
    if (host) hosts.set(host, (hosts.get(host) ?? 0) + requests);
  }
  signals.hosts = [...hosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, HOST_LIMIT)
    .map(([host, requests]) => ({ host, requests }));
  return signals;
}
