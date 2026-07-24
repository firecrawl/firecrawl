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
  tenantId: z.string().min(1).max(128),
  clientId: z.string().min(1).max(128),
  clientSecret: z.string().min(1).max(4096).optional(),
  dceUrl: z.url().refine(value => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "ingest.monitor.azure.com" ||
        url.hostname.endsWith(".ingest.monitor.azure.com"))
    );
  }, "dceUrl must be an Azure Monitor ingestion endpoint"),
  dcrImmutableId: z.string().min(1).max(256),
  streamName: z
    .string()
    .min(1)
    .max(256)
    .refine(value => value.startsWith("Custom-"), {
      message: "streamName must start with Custom-",
    }),
});

export const siemAuditConfigInputSchema = z.strictObject({
  enabled: z.boolean(),
  destination: azureSentinelDestinationInputSchema,
});

export type SiemAuditConfigInput = z.infer<typeof siemAuditConfigInputSchema>;

export interface AzureSentinelDestination {
  type: "azure_sentinel";
  tenantId: string;
  clientId: string;
  clientSecret: string;
  dceUrl: string;
  dcrImmutableId: string;
  streamName: string;
}

export interface OrgSiemAuditConfig {
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
