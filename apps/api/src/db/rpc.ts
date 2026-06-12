import { sql, SQL } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db, dbIndex } from "./connection";

type DB = NodePgDatabase;

async function execRows<T = Record<string, any>>(
  database: DB,
  query: SQL,
): Promise<T[]> {
  const res = await database.execute(query);
  return (res.rows ?? []) as T[];
}

// The pg driver returns bigint/numeric columns as strings (to avoid precision
// loss), and raw db.execute() bypasses the schema's mode: "number" mapping.
// Coerce known-numeric columns back to JS numbers at this boundary.
function toNum(v: unknown): number | null {
  return v == null ? null : Number(v);
}

// ============================================================================
// Main database RPCs
// ============================================================================

export type AuthCreditUsageChunkRow = Record<string, any> & {
  team_id: string | null;
  api_key: string;
};

export async function authCreditUsageChunk(
  database: DB,
  input_key: string,
  i_is_extract: boolean,
): Promise<AuthCreditUsageChunkRow[]> {
  const rows = await execRows<AuthCreditUsageChunkRow>(
    database,
    sql`select * from auth_credit_usage_chunk_47(input_key => ${input_key}, i_is_extract => ${i_is_extract}, tally_untallied_credits => ${true})`,
  );
  // api_key_id is a bigint column, so the pg driver hands it back as a string.
  for (const row of rows) {
    if (row.api_key_id != null) {
      row.api_key_id = toNum(row.api_key_id);
    }
  }
  return rows;
}

export function authCreditUsageChunkFromTeam(
  database: DB,
  input_team: string,
  i_is_extract: boolean,
): Promise<AuthCreditUsageChunkRow[]> {
  return execRows(
    database,
    sql`select * from auth_credit_usage_chunk_47_from_team(input_team => ${input_team}, i_is_extract => ${i_is_extract}, tally_untallied_credits => ${true})`,
  );
}

export function getAgentFreeRequestsLeft(
  i_team_id: string,
): Promise<{ free_requests_left: number }[]> {
  return execRows(
    db,
    sql`select * from get_agent_free_requests_left(i_team_id => ${i_team_id})`,
  );
}

export function agentConsumeFreeRequestIfLeft(
  i_team_id: string,
): Promise<{ consumed: boolean }[]> {
  return execRows(
    db,
    sql`select * from agent_consume_free_request_if_left(i_team_id => ${i_team_id})`,
  );
}

export function billTeam6(params: {
  team_id: string;
  subscription_id: string | null;
  fetch_subscription: boolean;
  credits: number;
  api_key_id: number | null;
  is_extract: boolean;
}): Promise<{ api_key: string }[]> {
  return execRows(
    db,
    sql`select * from bill_team_6(_team_id => ${params.team_id}, sub_id => ${params.subscription_id}, fetch_subscription => ${params.fetch_subscription}, credits => ${params.credits}, i_api_key_id => ${params.api_key_id}, is_extract_param => ${params.is_extract})`,
  );
}

export async function changeTrackingInsertScrape(params: {
  team_id: string;
  url: string;
  job_id: string;
  change_tracking_tag: string | null;
  date_added: string;
}): Promise<void> {
  await db.execute(
    sql`select change_tracking_insert_scrape(p_team_id => ${params.team_id}, p_url => ${params.url}, p_job_id => ${params.job_id}, p_change_tracking_tag => ${params.change_tracking_tag}, p_date_added => ${params.date_added}::timestamptz)`,
  );
}

export function creditsBilledByCrawlId(
  i_crawl_id: string,
): Promise<{ credits_billed: number }[]> {
  return execRows(
    db,
    sql`select * from credits_billed_by_crawl_id_2(i_crawl_id => ${i_crawl_id})`,
  );
}

export function diffGetLastScrape(
  i_team_id: string,
  i_url: string,
  i_tag: string | null,
): Promise<{ o_job_id: string; o_date_added: string }[]> {
  return execRows(
    db,
    sql`select * from diff_get_last_scrape_v7(i_team_id => ${i_team_id}, i_url => ${i_url}, i_tag => ${i_tag})`,
  );
}

export function getZdrCleanupBatch(
  p_limit: number,
): Promise<{ request_id: string; ids: string[] }[]> {
  return execRows(
    db,
    sql`select * from get_zdr_cleanup_batch_2(p_limit => ${p_limit})`,
  );
}

export function monitoringClaimDueMonitors<T = Record<string, any>>(params: {
  workerId: string;
  limit: number;
  leaseSeconds: number;
}): Promise<T[]> {
  return execRows(
    db,
    sql`select * from monitoring_claim_due_monitors(p_worker_id => ${params.workerId}, p_limit => ${params.limit}, p_lease_seconds => ${params.leaseSeconds})`,
  );
}

export async function updateTallyTeam(i_team_id: string): Promise<void> {
  await db.execute(sql`select update_tally_10_team(i_team_id => ${i_team_id})`);
}

// ============================================================================
// Index database RPCs
// ============================================================================

export async function insertOmceJobIfNeeded(
  i_domain_level: number,
  i_domain_hash: Buffer,
): Promise<void> {
  await dbIndex.execute(
    sql`select insert_omce_job_if_needed(i_domain_level => ${i_domain_level}, i_domain_hash => ${i_domain_hash})`,
  );
}

export function queryIndexAtSplitLevel(
  i_level: number,
  i_url_hash: Buffer,
  i_newer_than: string,
): Promise<{ resolved_url: string }[]> {
  return execRows(
    dbIndex,
    sql`select * from query_index_at_split_level(i_level => ${i_level}, i_url_hash => ${i_url_hash}, i_newer_than => ${i_newer_than}::timestamptz)`,
  );
}

export function queryIndexAtDomainSplitLevel(
  i_level: number,
  i_domain_hash: Buffer,
  i_newer_than: string,
): Promise<{ resolved_url: string }[]> {
  return execRows(
    dbIndex,
    sql`select * from query_index_at_domain_split_level(i_level => ${i_level}, i_domain_hash => ${i_domain_hash}, i_newer_than => ${i_newer_than}::timestamptz)`,
  );
}

export function queryOmceSignatures(
  i_domain_hash: Buffer,
  i_newer_than: string,
): Promise<{ signatures: any[] }[]> {
  return execRows(
    dbIndex,
    sql`select * from query_omce_signatures(i_domain_hash => ${i_domain_hash}, i_newer_than => ${i_newer_than}::timestamptz)`,
  );
}

export function queryEngpickerVerdict(
  i_domain_hash: Buffer,
): Promise<{ verdict: string }[]> {
  return execRows(
    dbIndex,
    sql`select * from query_engpicker_verdict(i_domain_hash => ${i_domain_hash})`,
  );
}

export function queryIndexAtSplitLevelWithMeta(
  i_level: number,
  i_url_hash: Buffer,
  i_newer_than: string,
): Promise<
  { resolved_url: string; title: string | null; description: string | null }[]
> {
  return execRows(
    dbIndex,
    sql`select * from query_index_at_split_level_with_meta(i_level => ${i_level}, i_url_hash => ${i_url_hash}, i_newer_than => ${i_newer_than}::timestamptz)`,
  );
}

export function queryIndexAtDomainSplitLevelWithMeta(
  i_level: number,
  i_domain_hash: Buffer,
  i_newer_than: string,
): Promise<
  { resolved_url: string; title: string | null; description: string | null }[]
> {
  return execRows(
    dbIndex,
    sql`select * from query_index_at_domain_split_level_with_meta(i_level => ${i_level}, i_domain_hash => ${i_domain_hash}, i_newer_than => ${i_newer_than}::timestamptz)`,
  );
}

export function queryDomainPriority(
  p_min_total: number,
  p_min_priority: number,
  p_lim: number,
  p_time: string,
): Promise<{ domain_hash: Buffer; priority: number }[]> {
  return execRows(
    dbIndex,
    sql`select * from query_domain_priority(p_min_total => ${p_min_total}, p_min_priority => ${p_min_priority}, p_lim => ${p_lim}, p_time => ${p_time}::timestamptz)`,
  );
}

export function queryIndexAtDomainSplitLevelOmce<T = Record<string, any>>(
  i_level: number,
  i_domain_hash: Buffer,
  i_newer_than: string,
  limit?: number,
): Promise<T[]> {
  return execRows(
    dbIndex,
    sql`select * from query_index_at_domain_split_level_omce(i_level => ${i_level}, i_domain_hash => ${i_domain_hash}, i_newer_than => ${i_newer_than}::timestamptz)${limit !== undefined ? sql` limit ${limit}` : sql``}`,
  );
}

export function queryMaxAge(
  i_domain_hash: Buffer,
): Promise<{ max_age: number | null }[]> {
  return execRows(
    dbIndex,
    sql`select * from query_max_age(i_domain_hash => ${i_domain_hash})`,
  );
}

type IndexGetRecentRow = {
  id: string;
  created_at: string;
  status: number;
  has_screenshot: boolean;
  has_screenshot_fullscreen: boolean;
  wait_time_ms: number | null;
};

// Same filters as index_get_recent_4, but also returns the per-entry
// capability columns so results can populate the Dragonfly index cache
// (services/index-cache.ts).
export async function indexGetRecent5(params: {
  url_hash: Buffer;
  max_age_ms: number;
  is_mobile: boolean;
  block_ads: boolean;
  feature_screenshot: boolean;
  feature_screenshot_fullscreen: boolean;
  location_country: string | null;
  location_languages: string[] | null;
  wait_time_ms: number;
  is_stealth: boolean;
  min_age_ms: number | null;
}): Promise<IndexGetRecentRow[]> {
  const rows = await execRows<IndexGetRecentRow>(
    dbIndex,
    sql`select * from index_get_recent_5(p_url_hash => ${params.url_hash}, p_max_age_ms => ${params.max_age_ms}, p_is_mobile => ${params.is_mobile}, p_block_ads => ${params.block_ads}, p_feature_screenshot => ${params.feature_screenshot}, p_feature_screenshot_fullscreen => ${params.feature_screenshot_fullscreen}, p_location_country => ${params.location_country}, p_location_languages => ${sql.param(params.location_languages)}::text[], p_wait_time_ms => ${params.wait_time_ms}, p_is_stealth => ${params.is_stealth}, p_min_age_ms => ${params.min_age_ms})`,
  );
  for (const row of rows) {
    row.wait_time_ms = toNum(row.wait_time_ms);
  }
  return rows;
}

export function queryTopUrlsForDomain<T = Record<string, any>>(
  p_domain_hash: Buffer,
  p_time_window: string,
  p_top_n: number,
): Promise<T[]> {
  return execRows(
    dbIndex,
    sql`select * from query_top_urls_for_domain(p_domain_hash => ${p_domain_hash}, p_time_window => ${p_time_window}::interval, p_top_n => ${p_top_n})`,
  );
}
