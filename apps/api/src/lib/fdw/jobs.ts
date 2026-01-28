import { getActivityLogsClickhouse } from "../../services/clickhouse";
import { logger } from "../logger";

const fdwLogger = logger.child({ module: "fdw" });

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FdwJobMode =
  | "scrape"
  | "crawl"
  | "batch_scrape"
  | "map"
  | "search"
  | "extract"
  | "agent"
  | "deep_research";

type FdwJobsQueryParams = {
  apiKeyId: number;
  startDate: Date;
  endDate: Date;
  mode?: FdwJobMode;
  search?: string;
  limit: number;
  offset: number;
};

type FdwJobRow = {
  job_id: string;
  mode: string;
  created_at: string;
  origin: string | null;
  url_or_query: string | null;
  success: boolean | null;
  credits_billed: number | null;
  num_docs: number | null;
  time_taken: number | null;
  message: string | null;
  error_count: number | null;
  agent_model: string | null;
  scrape_options: Record<string, unknown> | null;
  scrape_pdf_num_pages: number | null;
  api_key_id: number | null;
};

type ClickHouseJobRow = {
  job_id: string;
  mode: string;
  created_at: string;
  origin: string | null;
  url_or_query: string | null;
  success: boolean | null;
  credits_billed: number | string | null;
  num_docs: number | string | null;
  time_taken: number | string | null;
  message: string | null;
  error_count: number | string | null;
  agent_model: string | null;
  scrape_options: unknown;
  scrape_pdf_num_pages: number | string | null;
  api_key_id: number | string | null;
};

type ClickHouseJobOwnershipRow = {
  job_id: string;
  mode: string;
};

const formatDateForClickHouse = (date: Date) =>
  date.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);

const coerceNumber = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) {
    return null;
  }
  const num = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
};

const coerceInteger = (value: number | string | null | undefined) => {
  const num = coerceNumber(value);
  if (num === null) {
    return null;
  }
  return Number.isFinite(num) ? Math.trunc(num) : null;
};

const parseScrapeOptions = (value: unknown) => {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }

  return null;
};

export function buildFdwJobsQuery(params: FdwJobsQueryParams) {
  const conditions: string[] = [
    "r.api_key_id = {apiKeyId: UInt64}",
    "r.created_at >= {startDate: String}",
    "r.created_at <= {endDate: String}",
  ];

  const queryParams: Record<string, unknown> = {
    apiKeyId: params.apiKeyId,
    startDate: formatDateForClickHouse(params.startDate),
    endDate: formatDateForClickHouse(params.endDate),
    limit: params.limit,
    offset: params.offset,
  };

  if (params.mode) {
    conditions.push("r.kind = {modeFilter: String}");
    queryParams.modeFilter = params.mode;
  }

  if (params.search) {
    const trimmed = params.search.trim();
    if (trimmed) {
      if (UUID_REGEX.test(trimmed)) {
        conditions.push(`(
          r.id = toUUID({searchQuery: String})
          OR r.id IN (
            SELECT request_id
            FROM public_scrapes
            WHERE id = toUUID({searchQuery: String})
              AND _peerdb_is_deleted = 0
            ORDER BY _peerdb_version DESC
            LIMIT 1
          )
        )`);
      } else {
        conditions.push(
          "positionCaseInsensitive(r.target_hint, {searchQuery: String}) > 0",
        );
      }
      queryParams.searchQuery = trimmed;
    }
  }

  const query = `
    WITH recent_requests AS (
      SELECT
        r.id,
        r.kind,
        r.created_at,
        r.origin AS req_origin,
        r.target_hint,
        r.api_key_id
      FROM public_requests r
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.created_at DESC
      LIMIT {limit: UInt32}
      OFFSET {offset: UInt32}
    ),

    scrape_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'scrape'
    ),
    crawl_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'crawl'
    ),
    batch_scrape_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'batch_scrape'
    ),
    map_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'map'
    ),
    search_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'search'
    ),
    extract_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'extract'
    ),
    deep_research_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'deep_research'
    ),
    agent_request_ids AS (
      SELECT id FROM recent_requests WHERE kind = 'agent'
    ),

    filtered_scrapes AS (
      SELECT
        s.id AS request_id,
        argMax(s.url, s._peerdb_version) AS url,
        argMax(toNullable(s.is_successful), s._peerdb_version) AS is_successful,
        argMax(s.error, s._peerdb_version) AS error,
        argMax(toNullable(s.credits_cost), s._peerdb_version) AS credits_cost,
        argMax(toNullable(s.time_taken), s._peerdb_version) AS time_taken,
        argMax(s.options, s._peerdb_version) AS options,
        argMax(toNullable(s.pdf_num_pages), s._peerdb_version) AS pdf_num_pages
      FROM public_scrapes s
      WHERE s.id IN (SELECT id FROM scrape_request_ids)
        AND s._peerdb_is_deleted = 0
      GROUP BY s.id
    ),
    filtered_crawls AS (
      SELECT
        c.id AS request_id,
        argMax(c.url, c._peerdb_version) AS url,
        argMax(toNullable(c.cancelled), c._peerdb_version) AS cancelled,
        argMax(toNullable(c.credits_cost), c._peerdb_version) AS credits_cost,
        argMax(toNullable(c.num_docs), c._peerdb_version) AS num_docs
      FROM public_crawls c
      WHERE c.id IN (SELECT id FROM crawl_request_ids)
        AND c._peerdb_is_deleted = 0
      GROUP BY c.id
    ),
    filtered_batch_scrapes AS (
      SELECT
        bs.id AS request_id,
        argMax(toNullable(bs.cancelled), bs._peerdb_version) AS cancelled,
        argMax(toNullable(bs.credits_cost), bs._peerdb_version) AS credits_cost,
        argMax(toNullable(bs.num_docs), bs._peerdb_version) AS num_docs
      FROM public_batch_scrapes bs
      WHERE bs.id IN (SELECT id FROM batch_scrape_request_ids)
        AND bs._peerdb_is_deleted = 0
      GROUP BY bs.id
    ),
    filtered_maps AS (
      SELECT
        m.id AS request_id,
        argMax(m.url, m._peerdb_version) AS url,
        argMax(toNullable(m.credits_cost), m._peerdb_version) AS credits_cost,
        argMax(toNullable(m.num_results), m._peerdb_version) AS num_results
      FROM public_maps m
      WHERE m.id IN (SELECT id FROM map_request_ids)
        AND m._peerdb_is_deleted = 0
      GROUP BY m.id
    ),
    filtered_searches AS (
      SELECT
        sr.id AS request_id,
        argMax(sr.query, sr._peerdb_version) AS query,
        argMax(toNullable(sr.is_successful), sr._peerdb_version) AS is_successful,
        argMax(sr.error, sr._peerdb_version) AS error,
        argMax(toNullable(sr.credits_cost), sr._peerdb_version) AS credits_cost,
        argMax(toNullable(sr.num_results), sr._peerdb_version) AS num_results,
        argMax(toNullable(sr.time_taken), sr._peerdb_version) AS time_taken
      FROM public_searches sr
      WHERE sr.id IN (SELECT id FROM search_request_ids)
        AND sr._peerdb_is_deleted = 0
      GROUP BY sr.id
    ),
    filtered_extracts AS (
      SELECT
        e.id AS request_id,
        argMax(e.urls, e._peerdb_version) AS urls,
        argMax(toNullable(e.is_successful), e._peerdb_version) AS is_successful,
        argMax(e.error, e._peerdb_version) AS error,
        argMax(toNullable(e.credits_cost), e._peerdb_version) AS credits_cost
      FROM public_extracts e
      WHERE e.id IN (SELECT id FROM extract_request_ids)
        AND e._peerdb_is_deleted = 0
      GROUP BY e.id
    ),
    filtered_deep_researches AS (
      SELECT
        dr.id AS request_id,
        argMax(dr.query, dr._peerdb_version) AS query,
        argMax(toNullable(dr.credits_cost), dr._peerdb_version) AS credits_cost,
        argMax(toNullable(dr.time_taken), dr._peerdb_version) AS time_taken
      FROM public_deep_researches dr
      WHERE dr.id IN (SELECT id FROM deep_research_request_ids)
        AND dr._peerdb_is_deleted = 0
      GROUP BY dr.id
    ),
    filtered_agents AS (
      SELECT
        a.id AS request_id,
        argMax(toNullable(a.is_successful), a._peerdb_version) AS is_successful,
        argMax(a.error, a._peerdb_version) AS error,
        argMax(toNullable(a.credits_cost), a._peerdb_version) AS credits_cost,
        argMax(toNullable(a.time_taken), a._peerdb_version) AS time_taken,
        argMax(
          nullIf(getSubcolumn((a.options::JSON), 'model')::String, ''),
          a._peerdb_version
        ) AS agent_model
      FROM public_agents a
      WHERE a.id IN (SELECT id FROM agent_request_ids)
        AND a._peerdb_is_deleted = 0
      GROUP BY a.id
    ),
    crawl_error_counts AS (
      SELECT
        s.request_id,
        toUInt32(countIf(
          s.is_successful = false
          AND s.error != ''
          AND NOT startsWith(s.error, 'SCRAPE_RACED_REDIRECT_ERROR|')
          AND NOT position(s.error, 'URL does not match required include pattern') > 0
          AND NOT position(s.error, 'includePaths parameter') > 0
          AND NOT position(s.error, 'URL matches exclude pattern') > 0
          AND NOT position(s.error, 'excludePaths parameter') > 0
          AND NOT position(s.error, 'URL exceeds maximum crawl depth') > 0
          AND NOT position(s.error, 'Maximum discovery depth reached') > 0
          AND NOT position(s.error, 'maximum discovery depth') > 0
        )) AS error_count
      FROM public_scrapes s
      WHERE s.request_id IN (
        SELECT id FROM crawl_request_ids
        UNION ALL
        SELECT id FROM batch_scrape_request_ids
      )
        AND s._peerdb_is_deleted = 0
      GROUP BY s.request_id
    ),
    search_scrape_credits AS (
      SELECT
        s.request_id,
        SUM(coalesce(s.credits_cost, 0)) AS scrape_credits_cost
      FROM public_scrapes s
      WHERE s.request_id IN (SELECT id FROM search_request_ids)
        AND s._peerdb_is_deleted = 0
      GROUP BY s.request_id
    )

    SELECT
      toString(r.id) AS job_id,
      r.kind AS mode,
      formatDateTime(r.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
      r.req_origin AS origin,
      CASE r.kind
        WHEN 'scrape' THEN nullIf(s.url, '')
        WHEN 'crawl' THEN nullIf(c.url, '')
        WHEN 'batch_scrape' THEN nullIf(r.target_hint, '')
        WHEN 'map' THEN nullIf(m.url, '')
        WHEN 'search' THEN nullIf(sr.query, '')
        WHEN 'extract' THEN nullIf(arrayElement(e.urls, 1), '')
        WHEN 'deep_research' THEN nullIf(dr.query, '')
        WHEN 'agent' THEN nullIf(r.target_hint, '')
        ELSE nullIf(r.target_hint, '')
      END AS url_or_query,
      CASE r.kind
        WHEN 'scrape' THEN s.is_successful
        WHEN 'crawl' THEN if(c.cancelled = true, false, if(c.request_id IS NOT NULL, true, NULL))
        WHEN 'batch_scrape' THEN if(bs.cancelled = true, false, if(bs.request_id IS NOT NULL, true, NULL))
        WHEN 'map' THEN if(m.request_id IS NOT NULL, true, NULL)
        WHEN 'search' THEN sr.is_successful
        WHEN 'extract' THEN e.is_successful
        WHEN 'deep_research' THEN if(dr.request_id IS NOT NULL, true, NULL)
        WHEN 'agent' THEN a.is_successful
        ELSE NULL
      END AS success,
      CASE r.kind
        WHEN 'scrape' THEN s.credits_cost
        WHEN 'crawl' THEN c.credits_cost
        WHEN 'batch_scrape' THEN bs.credits_cost
        WHEN 'map' THEN m.credits_cost
        WHEN 'search' THEN coalesce(sr.credits_cost, 0) + coalesce(ssc.scrape_credits_cost, 0)
        WHEN 'extract' THEN e.credits_cost
        WHEN 'deep_research' THEN dr.credits_cost
        WHEN 'agent' THEN a.credits_cost
        ELSE NULL
      END AS credits_billed,
      CASE r.kind
        WHEN 'scrape' THEN 1
        WHEN 'crawl' THEN c.num_docs
        WHEN 'batch_scrape' THEN bs.num_docs
        WHEN 'map' THEN m.num_results
        WHEN 'search' THEN sr.num_results
        ELSE NULL
      END AS num_docs,
      CASE r.kind
        WHEN 'scrape' THEN s.time_taken
        WHEN 'search' THEN sr.time_taken
        WHEN 'deep_research' THEN dr.time_taken
        WHEN 'agent' THEN a.time_taken
        ELSE NULL
      END AS time_taken,
      CASE r.kind
        WHEN 'scrape' THEN nullIf(s.error, '')
        WHEN 'search' THEN nullIf(sr.error, '')
        WHEN 'extract' THEN nullIf(e.error, '')
        WHEN 'agent' THEN nullIf(a.error, '')
        ELSE NULL
      END AS message,
      CASE r.kind
        WHEN 'agent' THEN coalesce(a.agent_model, 'spark-1-pro')
        ELSE NULL
      END AS agent_model,
      ec.error_count AS error_count,
      s.options AS scrape_options,
      s.pdf_num_pages AS scrape_pdf_num_pages,
      r.api_key_id AS api_key_id
    FROM recent_requests r
    LEFT JOIN filtered_scrapes s ON s.request_id = r.id AND r.kind = 'scrape'
    LEFT JOIN filtered_crawls c ON c.request_id = r.id AND r.kind = 'crawl'
    LEFT JOIN filtered_batch_scrapes bs ON bs.request_id = r.id AND r.kind = 'batch_scrape'
    LEFT JOIN filtered_maps m ON m.request_id = r.id AND r.kind = 'map'
    LEFT JOIN filtered_searches sr ON sr.request_id = r.id AND r.kind = 'search'
    LEFT JOIN filtered_extracts e ON e.request_id = r.id AND r.kind = 'extract'
    LEFT JOIN filtered_deep_researches dr ON dr.request_id = r.id AND r.kind = 'deep_research'
    LEFT JOIN filtered_agents a ON a.request_id = r.id AND r.kind = 'agent'
    LEFT JOIN crawl_error_counts ec ON ec.request_id = r.id AND (r.kind = 'crawl' OR r.kind = 'batch_scrape')
    LEFT JOIN search_scrape_credits ssc ON ssc.request_id = r.id AND r.kind = 'search'
    ORDER BY r.created_at DESC
  `;

  return { query, queryParams };
}

export async function fetchFdwJobs(
  params: FdwJobsQueryParams,
): Promise<FdwJobRow[]> {
  const { query, queryParams } = buildFdwJobsQuery(params);
  const clickhouse = getActivityLogsClickhouse();
  const startedAt = Date.now();

  const result = await clickhouse.query({
    query,
    query_params: queryParams,
    format: "JSONEachRow",
  });

  const rows: ClickHouseJobRow[] = await result.json();
  const durationMs = Date.now() - startedAt;

  fdwLogger.info("ClickHouse fdw/jobs query", {
    durationMs,
    rowCount: rows.length,
  });

  return rows.map(row => ({
    job_id: row.job_id,
    mode: row.mode,
    created_at: row.created_at,
    origin: row.origin ?? null,
    url_or_query: row.url_or_query ?? null,
    success: row.success ?? null,
    credits_billed: coerceNumber(row.credits_billed),
    num_docs: coerceInteger(row.num_docs),
    time_taken: coerceNumber(row.time_taken),
    message: row.message ?? null,
    error_count: coerceInteger(row.error_count),
    agent_model: row.agent_model ?? null,
    scrape_options: parseScrapeOptions(row.scrape_options),
    scrape_pdf_num_pages: coerceInteger(row.scrape_pdf_num_pages),
    api_key_id: coerceInteger(row.api_key_id),
  }));
}

export async function fetchFdwJobOwnership(
  apiKeyId: number,
  jobIds: string[],
): Promise<ClickHouseJobOwnershipRow[]> {
  if (!jobIds.length) {
    return [];
  }

  const clickhouse = getActivityLogsClickhouse();
  const startedAt = Date.now();

  const result = await clickhouse.query({
    query: `
      SELECT
        toString(id) AS job_id,
        argMax(kind, _peerdb_version) AS mode
      FROM public_requests
      WHERE api_key_id = {apiKeyId: UInt64}
        AND id IN ({jobIds: Array(UUID)})
        AND _peerdb_is_deleted = 0
      GROUP BY id
    `,
    query_params: {
      apiKeyId,
      jobIds,
    },
    format: "JSONEachRow",
  });

  const rows: ClickHouseJobOwnershipRow[] = await result.json();
  const durationMs = Date.now() - startedAt;

  fdwLogger.info("ClickHouse fdw/job-results ownership query", {
    durationMs,
    rowCount: rows.length,
  });

  return rows;
}
