import { chQuery } from "../clickhouse-client";
import { normalizeDomain } from "./verdict";

// Read side of the threat protection security log (ENG-4987 pull export).
// Queries the `threat_protection_checks` ClickHouse table, scoped to a single
// org, newest-first, cursor-paginated.

interface ThreatProtectionLogsQuery {
  orgId: string;
  from?: Date;
  to?: Date;
  decision?: "allowed" | "blocked";
  domain?: string;
  cursor?: string;
  limit: number;
}

/** API-facing log entry (camelCase view of a threat_protection_checks row). */
interface ThreatProtectionLogEntry {
  id: string;
  timestamp: string;
  teamId: string | null;
  requestId: string | null;
  jobId: string | null;
  crawlId: string | null;
  endpoint: string | null;
  url: string | null;
  domain: string;
  mode: string;
  provider: string | null;
  riskScore: number | null;
  categories: string[];
  domainAgeDays: number | null;
  countryCode: string | null;
  decision: string;
  rule: string;
  providerConsulted: boolean;
  fromCache: boolean;
  origin: string | null;
  zeroDataRetention: boolean;
}

interface ThreatProtectionLogsPage {
  logs: ThreatProtectionLogEntry[];
  nextCursor: string | null;
}

interface ThreatProtectionCheckRow extends Record<string, unknown> {
  event_id: string;
  event_time: string;
  team_id: string;
  request_id: string;
  job_id: string;
  crawl_id: string;
  endpoint: string;
  url: string;
  url_domain: string;
  mode: string;
  provider: string;
  risk_score: number | null;
  categories: string[];
  domain_age_days: number | null;
  country_code: string;
  decision: string;
  rule: string;
  provider_consulted: number;
  from_cache: number;
  origin: string;
  zero_data_retention: number;
}

interface CursorPayload {
  /** event_time as returned by ClickHouse ("YYYY-MM-DD hh:mm:ss.mmm"). */
  t: string;
  /** event_id tiebreaker. */
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Returns null for malformed cursors (callers should 400). */
export function decodeThreatLogsCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.t !== "string" ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(parsed.t) ||
      typeof parsed.id !== "string" ||
      !UUID_RE.test(parsed.id)
    ) {
      return null;
    }
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

function rowToEntry(row: ThreatProtectionCheckRow): ThreatProtectionLogEntry {
  return {
    id: row.event_id,
    // ClickHouse returns DateTime64 as "YYYY-MM-DD hh:mm:ss.mmm" in UTC.
    timestamp: `${row.event_time.replace(" ", "T")}Z`,
    teamId: row.team_id || null,
    requestId: row.request_id || null,
    jobId: row.job_id || null,
    crawlId: row.crawl_id || null,
    endpoint: row.endpoint || null,
    url: row.url || null,
    domain: row.url_domain,
    mode: row.mode,
    provider: row.provider || null,
    riskScore: row.risk_score,
    categories: row.categories ?? [],
    domainAgeDays: row.domain_age_days,
    countryCode: row.country_code || null,
    decision: row.decision,
    rule: row.rule,
    providerConsulted: Boolean(row.provider_consulted),
    fromCache: Boolean(row.from_cache),
    origin: row.origin || null,
    zeroDataRetention: Boolean(row.zero_data_retention),
  };
}

/**
 * Queries the org's threat protection security log, newest-first. Returns
 * null when ClickHouse is not configured on this instance.
 */
export async function queryThreatProtectionLogs(
  query: ThreatProtectionLogsQuery,
): Promise<ThreatProtectionLogsPage | null> {
  const conditions: string[] = ["org_id = {orgId:String}"];
  const params: Record<string, unknown> = { orgId: query.orgId };

  if (query.from) {
    conditions.push("event_time >= {from:DateTime64(3)}");
    params.from = query.from;
  }
  if (query.to) {
    conditions.push("event_time <= {to:DateTime64(3)}");
    params.to = query.to;
  }
  if (query.decision) {
    conditions.push("decision = {decision:String}");
    params.decision = query.decision;
  }
  if (query.domain) {
    conditions.push("url_domain = {domain:String}");
    params.domain = normalizeDomain(query.domain);
  }
  if (query.cursor) {
    const cursor = decodeThreatLogsCursor(query.cursor);
    if (!cursor) {
      throw new InvalidThreatLogsCursorError();
    }
    conditions.push(
      "(event_time, event_id) < ({cursorTime:DateTime64(3)}, {cursorId:UUID})",
    );
    params.cursorTime = cursor.t;
    params.cursorId = cursor.id;
  }

  params.limit = query.limit + 1; // one extra row to detect the next page

  const rows = await chQuery<ThreatProtectionCheckRow>(
    `SELECT
        toString(event_id) AS event_id,
        toString(event_time) AS event_time,
        team_id, request_id, job_id, crawl_id, endpoint,
        url, url_domain, mode, provider, risk_score, categories,
        domain_age_days, country_code, decision, rule,
        provider_consulted, from_cache, origin, zero_data_retention
      FROM threat_protection_checks
      WHERE ${conditions.join(" AND ")}
      ORDER BY event_time DESC, event_id DESC
      LIMIT {limit:UInt32}`,
    params,
  );

  if (rows === null) return null;

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    logs: page.map(rowToEntry),
    nextCursor:
      hasMore && last
        ? encodeCursor({ t: last.event_time, id: last.event_id })
        : null,
  };
}

export class InvalidThreatLogsCursorError extends Error {
  constructor() {
    super("Invalid cursor.");
  }
}
