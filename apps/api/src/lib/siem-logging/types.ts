import { z } from "zod";
import type {
  ThreatDecisionRule,
  ThreatProvider,
} from "../threat-protection/types";

export const auditMetadataSchema = z.strictObject({
  username: z.string().max(1024),
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
  /**
   * The rule that produced {@link decision}. Local-policy rules (blacklist,
   * blocked-tld) deny without consulting a provider; only "risk-score" with a
   * non-null {@link provider} is a provider-confirmed threat. The destination
   * DCR transform keys ASim EventSeverity off exactly that distinction, so the
   * three fields below always describe one decision — never a union across the
   * decisions taken for one scrape.
   */
  rule: ThreatDecisionRule;
  provider: ThreatProvider | null;
  categories: string[];
  /**
   * Present only for providers with the concept (Zscaler): true when the
   * URL carried a security-alert classification
   * (`urlClassificationsWithSecurityAlert`). Only this normalized flag is
   * exported — never the provider's raw response payload.
   */
  security_alert?: boolean;
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
  audit_metadata?: AuditMetadata;
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

export interface SiemLoggingMessage {
  orgId: string;
  event: ScrapeActivityEvent;
}

type SiemDeliveryErrorKind =
  | "invalid_credentials"
  | "schema_rejection"
  | "rate_limited"
  | "delivery_error";

export class SiemDeliveryError extends Error {
  /**
   * Events the destination accepted before this failure. A batch is sent as
   * several compressed chunks, so a late chunk failing does not undo the earlier
   * ones — without this the caller would count accepted events as failed and
   * then count them again as delivered when the batch retries.
   */
  public deliveredEvents = 0;

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
