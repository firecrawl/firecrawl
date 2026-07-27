import { z } from "zod";
import type {
  ThreatDecisionRule,
  ThreatProvider,
} from "../threat-protection/types";

export const auditMetadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(1024))
  .refine(value => Object.keys(value).length <= 32, {
    message: "auditMetadata may contain at most 32 fields",
  });

export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

const azureSentinelDestinationInputSchema = z.strictObject({
  type: z.literal("azure_sentinel"),
  tenantId: z.string().trim().min(1).max(128),
  clientId: z.string().trim().min(1).max(128),
  clientSecret: z.string().trim().min(1).max(4096).optional(),
  dceUrl: z
    .string()
    .trim()
    .pipe(
      z.url().refine(value => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          (url.hostname === "ingest.monitor.azure.com" ||
            url.hostname.endsWith(".ingest.monitor.azure.com"))
        );
      }, "dceUrl must be a credential-free Azure Monitor ingestion endpoint"),
    ),
  dcrImmutableId: z.string().trim().min(1).max(256),
  streamName: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine(value => value.startsWith("Custom-"), {
      message: "streamName must start with Custom-",
    }),
});

export const siemLoggingConfigInputSchema = z.strictObject({
  enabled: z.boolean(),
  destination: azureSentinelDestinationInputSchema,
});

export type SiemLoggingConfigInput = z.infer<
  typeof siemLoggingConfigInputSchema
>;

export interface AzureSentinelDestination {
  type: "azure_sentinel";
  tenantId: string;
  clientId: string;
  clientSecret: string;
  dceUrl: string;
  dcrImmutableId: string;
  streamName: string;
}

export interface OrgSiemLoggingConfig {
  orgId: string;
  enabled: boolean;
  destination: AzureSentinelDestination;
  createdAt: string | null;
  updatedAt: string | null;
}

export type ScrapeActivityResult =
  | "success"
  | "failure"
  | "blocked"
  | "cancelled";

export interface ScrapeActivityThreat {
  decision: "allow" | "deny";
  rule: ThreatDecisionRule;
  provider: ThreatProvider | null;
  categories: string[];
  security_alert: {
    detected: boolean;
    category: string | null;
  };
}

export interface ScrapeActivityEvent {
  schema_version: 1;
  event_type: "scrape_activity";
  scrape_id: string;
  request_id: string;
  endpoint:
    | "scrape"
    | "crawl"
    | "batch_scrape"
    | "search"
    | "extract"
    | "agent"
    | "parse"
    | "unknown";
  team_id: string;
  org_id: string;
  api_key: {
    id: string | null;
    name: string | null;
  };
  audit_metadata: AuditMetadata;
  started_at: string;
  completed_at: string;
  url: string;
  domain: string;
  http_method: "GET";
  http_status: number | null;
  result: ScrapeActivityResult;
  error: {
    code: string | null;
    message: string;
  } | null;
  origin: string;
  integration: string | null;
  zero_data_retention: boolean;
  threat?: ScrapeActivityThreat;
}

export interface SiemLoggingJobData {
  orgId: string;
  event: ScrapeActivityEvent;
}

type SiemDeliveryErrorKind =
  | "invalid_credentials"
  | "schema_rejection"
  | "rate_limited"
  | "delivery_error"
  | "payload_too_large";

export class SiemDeliveryError extends Error {
  constructor(
    public readonly kind: SiemDeliveryErrorKind,
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SiemDeliveryError";
  }
}
