import { randomUUID } from "crypto";
import { logger as _logger } from "../logger";
import { enqueueSiemThreatEvent } from "../../services/webhook/siem";
import { getOrgIdForTeam } from "./store";
import type { ThreatCheckDedup, ThreatDecision } from "./types";

// Security-event emission for threat protection (ENG-4986/4987). Every
// decision produced by checkDomain() flows through emitThreatCheck(), which
// delivers to the org's SIEM destination (batched webhook push) when one is
// configured — and nowhere else. The whole feature is zero-data-retention:
// security events are never persisted on our side (no ClickHouse, no
// Postgres); our only copy lives in the transient in-memory SIEM buffer for
// at most the flush interval. Orgs that want an audit trail configure a SIEM
// destination — that archive is theirs, on their infrastructure.
//
// Retention rules (applied in buildThreatCheckEvent):
//  * zero-data-retention requests keep the domain but drop the full URL
//  * the raw provider payload (verdict.raw) is NEVER included — the event
//    carries only the normalized verdict fields (risk score, categories).
//    The raw payload stays in server logs only.
//
// Emission is strictly fire-and-forget: it never throws and never delays the
// enforcement hot path.

const logger = _logger.child({ module: "threat-protection-logging" });

/**
 * Request context threaded into checkDomain(). Everything is optional —
 * call sites pass whatever is cheaply available.
 */
export interface ThreatCheckContext {
  teamId?: string;
  orgId?: string;
  requestId?: string;
  jobId?: string;
  crawlId?: string;
  /** API surface the check ran for, e.g. "scrape", "crawl", "map". */
  endpoint?: string;
  /** Full URL being checked, when the check is tied to a single URL. */
  url?: string;
  origin?: string;
  zeroDataRetention?: boolean;
  /**
   * Request/job-scoped dedup handle (see {@link ThreatCheckDedup}). When set,
   * checkDomain() reuses the in-flight decision for a domain already checked
   * within this request instead of re-scanning it. Strictly in-memory and
   * request-scoped — never persisted, never shared across requests (ZDR).
   */
  dedup?: ThreatCheckDedup;
}

/**
 * Normalized security event. snake_case on purpose: this exact shape is the
 * ClickHouse row AND the SIEM webhook event payload.
 */
export interface ThreatCheckEvent {
  event_id: string;
  event_time: string;
  team_id: string;
  org_id: string;
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
  decision: "allowed" | "blocked";
  rule: string;
  provider_consulted: boolean;
  from_cache: boolean;
  origin: string;
  zero_data_retention: boolean;
}

export function buildThreatCheckEvent(
  domain: string,
  decision: ThreatDecision,
  ctx: ThreatCheckContext,
  orgId?: string | null,
): ThreatCheckEvent {
  const zdr = ctx.zeroDataRetention === true;
  const verdict = decision.verdict;

  return {
    event_id: randomUUID(),
    event_time: new Date().toISOString(),
    team_id: ctx.teamId ?? "",
    org_id: orgId ?? ctx.orgId ?? "",
    request_id: ctx.requestId ?? "",
    job_id: ctx.jobId ?? "",
    crawl_id: ctx.crawlId ?? "",
    endpoint: ctx.endpoint ?? "",
    // ZDR: keep the domain, drop the URL. verdict.raw is never included.
    url: zdr ? "" : (ctx.url ?? ""),
    url_domain: domain,
    mode: decision.mode,
    provider: verdict?.provider ?? "",
    risk_score: verdict?.riskScore ?? null,
    categories: verdict?.categories ?? [],
    decision: decision.allowed ? "allowed" : "blocked",
    rule: decision.rule,
    provider_consulted: decision.providerConsulted,
    from_cache: verdict?.fromCache ?? false,
    origin: ctx.origin ?? "",
    zero_data_retention: zdr,
  };
}

// team -> org resolution cache. The mapping effectively never changes, so a
// short in-memory TTL cache keeps the emit path off Postgres.
const ORG_ID_CACHE_TTL_MS = 10 * 60 * 1000;
const orgIdCache = new Map<string, { orgId: string | null; expires: number }>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOrgIdCached(teamId: string): Promise<string | null> {
  // Pseudo teams like "sitemap"/"robots-txt" are not UUIDs and have no org.
  if (!UUID_RE.test(teamId)) return null;

  const cached = orgIdCache.get(teamId);
  if (cached && cached.expires > Date.now()) return cached.orgId;

  const orgId = await getOrgIdForTeam(teamId);
  orgIdCache.set(teamId, {
    orgId,
    expires: Date.now() + ORG_ID_CACHE_TTL_MS,
  });
  return orgId;
}

/**
 * Emits a security event for a threat protection decision. Fire-and-forget:
 * never throws, never blocks the caller. Decisions with mode "off" are not
 * events (the feature was disabled; checkDomain's "off" branch is defensive
 * only — enforcement skips the check entirely in that case).
 */
export function emitThreatCheck(
  domain: string,
  decision: ThreatDecision,
  ctx: ThreatCheckContext,
): void {
  if (decision.mode === "off") return;

  void (async () => {
    const orgId =
      ctx.orgId ??
      (ctx.teamId ? await resolveOrgIdCached(ctx.teamId) : null) ??
      null;
    const event = buildThreatCheckEvent(domain, decision, ctx, orgId);

    if (orgId) {
      enqueueSiemThreatEvent(orgId, event);
    }
  })().catch(error => {
    logger.warn("Failed to emit threat protection check event", {
      error,
      domain,
      teamId: ctx.teamId,
    });
  });
}
