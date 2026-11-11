import { config } from "../config";
import { getBigtableTable } from "./bigtable-client";
import { saltedUuidV7RowKey } from "./bigtable-row-key";
import { persistedTeamId } from "./keyless-team";
import { setSpanAttributes, withSpan } from "./otel-tracer";

/**
 * Default lifetime of a job's access row, used by writes that do not pass
 * their own `expiresAt` and as the fallback expiry where no row exists. It is
 * not every row's actual expiry: deep research writes a shorter TTL, and
 * crawl and batch scrape write a per-key `crawlTtlHours`.
 */
export const JOB_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

const FAMILY = "j";
const QUALIFIER = "v";
export function normalizeJobAccessTeamId(teamId: string): string {
  return persistedTeamId(teamId);
}

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

export type ApiJobAccess = {
  teamId: string;
  kind: ApiJobKind;
  expiresAtMs: number;
  clientOrigin?: string;
  /**
   * An agent run's zero data retention, in minutes, fixed when the run
   * started. Set only on ZDR agent runs; rows written before it existed have
   * none.
   */
  zeroDataRetentionMinutes?: number;
};

export function isApiJobKind(kind: string): kind is ApiJobKind {
  return API_JOB_KINDS.includes(kind as ApiJobKind);
}

function parseApiJobAccess(value: Buffer | string): ApiJobAccess {
  const parsed: unknown = JSON.parse(value.toString());
  const row = parsed as Record<string, unknown>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    row.version !== 1 ||
    typeof row.teamId !== "string" ||
    typeof row.kind !== "string" ||
    !isApiJobKind(row.kind) ||
    typeof row.expiresAtMs !== "number" ||
    !Number.isFinite(row.expiresAtMs) ||
    (row.clientOrigin !== undefined && typeof row.clientOrigin !== "string") ||
    (row.zeroDataRetentionMinutes !== undefined &&
      (typeof row.zeroDataRetentionMinutes !== "number" ||
        !Number.isFinite(row.zeroDataRetentionMinutes) ||
        row.zeroDataRetentionMinutes <= 0))
  ) {
    throw new Error("Invalid Bigtable job access row");
  }
  return parsed as ApiJobAccess;
}

export async function readApiJobAccess(
  id: string,
): Promise<ApiJobAccess | null> {
  const tableId = config.BIGTABLE_JOB_ACCESS_TABLE;
  if (!tableId) return null;

  return withSpan("bigtable.job_access.read", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.operation": "getRows",
    });
    const table = await getBigtableTable(tableId);
    const [rows] = await table.getRows({
      keys: [saltedUuidV7RowKey(id)],
      filter: [{ column: { name: QUALIFIER, cellLimit: 1 } }],
    });
    const cells = rows[0]?.data?.[FAMILY]?.[QUALIFIER];
    const cell = Array.isArray(cells) ? cells[0] : undefined;
    if (cell?.value == null) {
      setSpanAttributes(span, { "bigtable.read.outcome": "not_found" });
      return null;
    }

    const access = parseApiJobAccess(cell.value);
    if (access.expiresAtMs <= Date.now()) {
      setSpanAttributes(span, { "bigtable.read.outcome": "expired" });
      return access;
    }
    setSpanAttributes(span, {
      "bigtable.read.outcome": "found",
      "job_access.kind": access.kind,
    });
    return access;
  });
}

export async function writeApiJobAccess(params: {
  id: string;
  teamId: string;
  kind: ApiJobKind;
  expiresAt: Date;
  clientOrigin?: string | null;
  zeroDataRetention?: boolean;
  zeroDataRetentionMinutes?: number;
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
          ...(params.kind === "agent" &&
          params.zeroDataRetention &&
          params.zeroDataRetentionMinutes !== undefined
            ? { zeroDataRetentionMinutes: params.zeroDataRetentionMinutes }
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
