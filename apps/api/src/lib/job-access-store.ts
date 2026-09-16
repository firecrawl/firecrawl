import { config } from "../config";
import { getBigtableTable } from "./bigtable-client";
import { saltedUuidV7RowKey } from "./bigtable-row-key";
import { setSpanAttributes, withSpan } from "./otel-tracer";

const FAMILY = "j";
const QUALIFIER = "v";

export const API_JOB_KINDS = [
  "scrape",
  "crawl",
  "batch_scrape",
  "extract",
  "agent",
  "llmstxt",
  "deep_research",
] as const;

export type ApiJobKind = (typeof API_JOB_KINDS)[number];

export function isApiJobKind(kind: string): kind is ApiJobKind {
  return API_JOB_KINDS.includes(kind as ApiJobKind);
}

export async function writeApiJobAccess(params: {
  id: string;
  teamId: string;
  kind: ApiJobKind;
  expiresAt: Date;
  clientOrigin?: string | null;
  zeroDataRetention?: boolean;
}): Promise<boolean> {
  const tableId = config.BIGTABLE_JOB_ACCESS_TABLE;
  if (!tableId) return false;

  return withSpan(
    "bigtable.job_access.write",
    async span => {
      setSpanAttributes(span, {
        "db.system": "bigtable",
        "bigtable.table": tableId,
        "bigtable.operation": "mutate",
        "job_access.kind": params.kind,
      });
      const value = Buffer.from(
        JSON.stringify({
          version: 1,
          teamId: params.teamId,
          kind: params.kind,
          expiresAtMs: params.expiresAt.getTime(),
          ...(params.kind === "agent" && params.clientOrigin
            ? { clientOrigin: params.clientOrigin }
            : {}),
        }),
      );
      const table = await getBigtableTable(tableId);
      await table.mutate([
        {
          key: saltedUuidV7RowKey(params.id),
          method: "insert",
          data: {
            [FAMILY]: {
              [QUALIFIER]: {
                value,
                timestamp: params.expiresAt,
              },
            },
          },
        },
      ]);
      return true;
    },
    { zeroDataRetention: params.zeroDataRetention },
  );
}
