import type { Document } from "../../controllers/v2/types";
import type { ScrapeJobSingleUrls } from "../../types";
import type { ThreatDecision } from "../threat-protection/types";
import {
  CrawlDenialError,
  JobCancelledError,
  TransportableError,
} from "../error";
import { UnsafeDomainBlockedError } from "../threat-protection/error";
import type {
  AuditMetadata,
  ScrapeActivityEvent,
  ScrapeActivityResult,
  ScrapeActivityThreat,
} from "./types";

export interface ScrapeActivityOutcome {
  success: boolean;
  document?: Document | null;
  error?: unknown;
  threatDecisions?: ThreatDecision[];
  startedAt: number;
  completedAt: number;
}

export interface RejectedScrapeActivity {
  scrapeId: string;
  requestId: string;
  endpoint: ScrapeActivityEvent["endpoint"];
  teamId: string;
  apiKeyId?: string | number | null;
  auditMetadata?: AuditMetadata;
  startedAt?: number;
  completedAt?: number;
  url: string;
  error: unknown;
  threatDecisions?: ThreatDecision[];
  origin: string;
  integration?: string | null;
  zeroDataRetention: boolean;
}

function endpointForJob(
  job: ScrapeJobSingleUrls,
): ScrapeActivityEvent["endpoint"] {
  const endpoint = job.billing?.endpoint;
  if (
    endpoint === "scrape" ||
    endpoint === "crawl" ||
    endpoint === "batch_scrape" ||
    endpoint === "search" ||
    endpoint === "extract" ||
    endpoint === "agent" ||
    endpoint === "parse"
  ) {
    return endpoint;
  }
  if (job.internalOptions?.isParse) return "parse";
  if (job.from_extract) return "extract";
  if (job.crawl_id) {
    return job.crawlerOptions === null ? "batch_scrape" : "crawl";
  }
  return "scrape";
}

function resultForOutcome(
  outcome: ScrapeActivityOutcome,
): ScrapeActivityResult {
  if (outcome.success) return "success";
  if (
    outcome.error instanceof CrawlDenialError ||
    outcome.error instanceof UnsafeDomainBlockedError ||
    outcome.threatDecisions?.some(decision => !decision.allowed)
  ) {
    return "blocked";
  }
  if (outcome.error instanceof JobCancelledError) return "cancelled";
  return "failure";
}

// One scrape can take several decisions (the initial URL plus a re-check per
// redirect hop). Report the deciding one — the first deny, else the last allow —
// and take its categories and provider from that same decision. Unioning
// categories across decisions would let a local-rule deny (which never calls a
// provider, so carries no categories) inherit another hop's threat categories
// and be scored as a provider-confirmed threat downstream.
function threatForDecisions(
  decisions: ThreatDecision[] | undefined,
): ScrapeActivityThreat | undefined {
  if (!decisions || decisions.length === 0) return undefined;
  const decision =
    decisions.find(candidate => !candidate.allowed) ??
    decisions[decisions.length - 1];
  return {
    decision: decision.allowed ? "allow" : "deny",
    rule: decision.rule,
    provider: decision.verdict?.provider ?? null,
    categories: [...new Set(decision.verdict?.categories ?? [])],
    ...(typeof decision.verdict?.securityAlert === "boolean"
      ? { security_alert: decision.verdict.securityAlert }
      : {}),
  };
}

function errorForOutcome(
  outcome: ScrapeActivityOutcome,
): ScrapeActivityEvent["error"] {
  if (outcome.success || outcome.error === undefined) return null;
  const error =
    outcome.error instanceof Error
      ? outcome.error
      : new Error(serializeThrownValue(outcome.error));
  return {
    code: error instanceof TransportableError ? error.code : null,
    message: error.message.slice(0, 2048),
  };
}

function serializeThrownValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === "bigint") return candidate.toString();
      if (candidate && typeof candidate === "object") {
        if (seen.has(candidate)) return "[Circular]";
        seen.add(candidate);
      }
      return candidate;
    });
    return serialized ?? String(value);
  } catch {
    return "Non-Error value thrown";
  }
}

interface ScrapeActivityEventSource {
  scrapeId: string;
  requestId: string;
  endpoint: ScrapeActivityEvent["endpoint"];
  teamId: string;
  apiKeyId: string | number | null | undefined;
  auditMetadata: AuditMetadata | undefined;
  url: string;
  origin: string;
  integration: string | null | undefined;
  zeroDataRetention: boolean;
  httpStatus: number | null;
}

function buildEvent(
  source: ScrapeActivityEventSource,
  orgId: string,
  apiKeyName: string | null,
  outcome: ScrapeActivityOutcome,
): ScrapeActivityEvent {
  let domain = "";
  try {
    domain = new URL(source.url).hostname.toLowerCase();
  } catch {}

  const event: ScrapeActivityEvent = {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: source.scrapeId,
    request_id: source.requestId,
    endpoint: source.endpoint,
    team_id: source.teamId,
    org_id: orgId,
    api_key: {
      id: source.apiKeyId == null ? null : String(source.apiKeyId),
      name: apiKeyName,
    },
    started_at: new Date(outcome.startedAt).toISOString(),
    completed_at: new Date(outcome.completedAt).toISOString(),
    url: source.url,
    domain,
    http_method: "GET",
    http_status: source.httpStatus,
    result: resultForOutcome(outcome),
    error: errorForOutcome(outcome),
    origin: source.origin,
    integration: source.integration ?? null,
    zero_data_retention: source.zeroDataRetention,
  };
  if (source.auditMetadata) event.audit_metadata = source.auditMetadata;
  const threat = threatForDecisions(outcome.threatDecisions);
  if (threat) event.threat = threat;
  return event;
}

export function buildScrapeActivityEvent(
  jobId: string,
  job: ScrapeJobSingleUrls,
  orgId: string,
  apiKeyName: string | null,
  outcome: ScrapeActivityOutcome,
): ScrapeActivityEvent {
  return buildEvent(
    {
      scrapeId: jobId,
      requestId: job.requestId ?? job.crawl_id ?? jobId,
      endpoint: endpointForJob(job),
      teamId: job.team_id,
      apiKeyId: job.apiKeyId,
      auditMetadata: job.scrapeOptions.auditMetadata,
      url: job.url,
      origin: job.origin,
      integration: job.integration,
      zeroDataRetention: job.zeroDataRetention,
      httpStatus: outcome.document?.metadata.statusCode ?? null,
    },
    orgId,
    apiKeyName,
    outcome,
  );
}

export function buildRejectedScrapeActivityEvent(
  input: RejectedScrapeActivity,
  orgId: string,
  apiKeyName: string | null,
): ScrapeActivityEvent {
  const startedAt = input.startedAt ?? Date.now();
  const outcome: ScrapeActivityOutcome = {
    success: false,
    error: input.error,
    threatDecisions: input.threatDecisions,
    startedAt,
    completedAt: input.completedAt ?? startedAt,
  };
  return buildEvent(
    {
      scrapeId: input.scrapeId,
      requestId: input.requestId,
      endpoint: input.endpoint,
      teamId: input.teamId,
      apiKeyId: input.apiKeyId,
      auditMetadata: input.auditMetadata,
      url: input.url,
      origin: input.origin,
      integration: input.integration,
      zeroDataRetention: input.zeroDataRetention,
      httpStatus: null,
    },
    orgId,
    apiKeyName,
    outcome,
  );
}
