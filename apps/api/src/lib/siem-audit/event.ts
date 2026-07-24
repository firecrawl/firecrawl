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
  apiKeyId?: number | null;
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

function threatForDecisions(
  decisions: ThreatDecision[] | undefined,
): ScrapeActivityThreat | undefined {
  if (!decisions || decisions.length === 0) return undefined;
  const decision =
    decisions.find(candidate => !candidate.allowed) ??
    decisions[decisions.length - 1];
  const categories = [
    ...new Set(
      decisions.flatMap(candidate => candidate.verdict?.categories ?? []),
    ),
  ];
  return {
    decision: decision.allowed ? "allow" : "deny",
    rule: decision.rule,
    provider: decision.verdict?.provider ?? null,
    categories,
    security_alert: {
      detected: categories.length > 0,
      category: categories[0] ?? null,
    },
  };
}

function errorForOutcome(
  outcome: ScrapeActivityOutcome,
): ScrapeActivityEvent["error"] {
  if (outcome.success || outcome.error === undefined) return null;
  const error =
    outcome.error instanceof Error
      ? outcome.error
      : new Error(
          typeof outcome.error === "string"
            ? outcome.error
            : JSON.stringify(outcome.error),
        );
  return {
    code: error instanceof TransportableError ? error.code : null,
    message: error.message.slice(0, 2048),
  };
}

export function buildScrapeActivityEvent(
  jobId: string,
  job: ScrapeJobSingleUrls,
  orgId: string,
  apiKeyName: string | null,
  outcome: ScrapeActivityOutcome,
): ScrapeActivityEvent {
  let domain = "";
  try {
    domain = new URL(job.url).hostname.toLowerCase();
  } catch {}

  const event: ScrapeActivityEvent = {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: jobId,
    request_id: job.requestId ?? job.crawl_id ?? jobId,
    endpoint: endpointForJob(job),
    team_id: job.team_id,
    org_id: orgId,
    api_key: {
      id: job.apiKeyId == null ? null : String(job.apiKeyId),
      name: apiKeyName,
    },
    audit_metadata: job.auditMetadata ?? job.scrapeOptions.auditMetadata ?? {},
    started_at: new Date(outcome.startedAt).toISOString(),
    completed_at: new Date(outcome.completedAt).toISOString(),
    url: job.url,
    domain,
    http_method: "GET",
    http_status: outcome.document?.metadata.statusCode ?? null,
    result: resultForOutcome(outcome),
    error: errorForOutcome(outcome),
    origin: job.origin,
    integration: job.integration ?? null,
    zero_data_retention: job.zeroDataRetention,
  };
  const threat = threatForDecisions(outcome.threatDecisions);
  if (threat) event.threat = threat;
  return event;
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
  let domain = "";
  try {
    domain = new URL(input.url).hostname.toLowerCase();
  } catch {}

  const event: ScrapeActivityEvent = {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: input.scrapeId,
    request_id: input.requestId,
    endpoint: input.endpoint,
    team_id: input.teamId,
    org_id: orgId,
    api_key: {
      id: input.apiKeyId == null ? null : String(input.apiKeyId),
      name: apiKeyName,
    },
    audit_metadata: input.auditMetadata ?? {},
    started_at: new Date(outcome.startedAt).toISOString(),
    completed_at: new Date(outcome.completedAt).toISOString(),
    url: input.url,
    domain,
    http_method: "GET",
    http_status: null,
    result: resultForOutcome(outcome),
    error: errorForOutcome(outcome),
    origin: input.origin,
    integration: input.integration ?? null,
    zero_data_retention: input.zeroDataRetention,
  };
  const threat = threatForDecisions(input.threatDecisions);
  if (threat) event.threat = threat;
  return event;
}
