import { Bigtable, Table } from "@google-cloud/bigtable";
import crypto from "crypto";
import { config } from "../config";
import { logger } from "./logger";

// Change tracking bookkeeping, Bigtable variant. One row per
// (team_id, url, tag) holding the latest scrape's job id; content itself
// lives in GCS. Cell timestamp = date_added, family GC rule
// max_versions=1, so reads return the highest date_added and regressed
// (out-of-order) writes are shadowed then collected at compaction.
//
// Row key: team_id || sha256(url) || sha256(tag)
// - team_id first: team-scoped prefix operations (bulk delete on cleanup)
//   stay a single range.
// - url before tag: the dominant write mix (every plain-markdown scrape)
//   carries tag=null, so the first hashed position must hold the
//   high-entropy component; a near-constant tag there would funnel each
//   team's bulk traffic into one contiguous sub-band.
// - tag null is encoded injectively (0x00 vs 0x01+tag) so null and ""
//   stay distinct keys, mirroring the Postgres semantics.

const FAMILY = "m";
const QUALIFIER = "job";
const TABLE_ID = config.BIGTABLE_CHANGE_TRACKING_TABLE || "change_tracking";

function sha256(data: crypto.BinaryLike): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function tagHash(tag: string | null): Buffer {
  if (tag === null) {
    return sha256(Buffer.from([0x00]));
  }
  return sha256(Buffer.concat([Buffer.from([0x01]), Buffer.from(tag, "utf8")]));
}

export function changeTrackingRowKey(
  teamId: string,
  url: string,
  tag: string | null,
): Buffer {
  // Fixed-width url/tag digests make the key unambiguously splittable at
  // len - 64 regardless of what bytes appear in team_id/url/tag.
  return Buffer.concat([
    Buffer.from(teamId, "utf8"),
    sha256(Buffer.from(url, "utf8")),
    tagHash(tag),
  ]);
}

export function changeTrackingBigtableConfigured(): boolean {
  return !!config.BIGTABLE_INSTANCE_ID;
}

let bigtableClient: Bigtable | null = null;
function getBigtable(): Bigtable {
  if (!bigtableClient) {
    bigtableClient = new Bigtable({
      projectId: config.BIGTABLE_PROJECT_ID,
      ...(config.BIGTABLE_APP_PROFILE_ID
        ? { appProfileId: config.BIGTABLE_APP_PROFILE_ID }
        : {}),
    });
  }
  return bigtableClient;
}

let tableReady: Promise<Table> | null = null;

/** Idempotently provisions the table + column family (GC: max 1 version). */
export function ensureChangeTrackingTable(): Promise<Table> {
  if (!tableReady) {
    tableReady = (async () => {
      const table = getBigtable()
        .instance(config.BIGTABLE_INSTANCE_ID!)
        .table(TABLE_ID);
      const [tableExists] = await table.exists();
      if (!tableExists) {
        try {
          await table.create({
            families: [{ name: FAMILY, rule: { versions: 1 } }],
          });
        } catch (error: any) {
          // Concurrent creation by another process is fine.
          if (
            !String(error?.message || "").match(/already\s+exists/i) &&
            !String(error?.code || "").match(/ALREADY_EXISTS/)
          ) {
            throw error;
          }
        }
      } else {
        const family = table.family(FAMILY);
        const [familyExists] = await family.exists();
        if (!familyExists) {
          try {
            await table.createFamily(FAMILY, { rule: { versions: 1 } });
          } catch (error: any) {
            if (
              !String(error?.message || "").match(/already\s+exists/i) &&
              !String(error?.code || "").match(/ALREADY_EXISTS/)
            ) {
              throw error;
            }
          }
        }
      }
      return table;
    })().catch(error => {
      // Reset so the next caller retries provisioning instead of being
      // stuck with a rejected promise forever.
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

type ChangeTrackingScrapeRow = {
  team_id: string;
  url: string;
  job_id: string;
  tag: string | null;
  /** When the scrape was logged; becomes the cell timestamp. */
  date_added: Date;
};

/** Upserts latest-scrape pointers. Older date_added cannot clobber newer. */
export async function changeTrackingInsertScrapesBigtable(
  rows: ChangeTrackingScrapeRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const table = await ensureChangeTrackingTable();
  await table.mutate(
    rows.map(row => ({
      // Runtime accepts Buffer keys (converted verbatim); the .d.ts only
      // declares string.
      key: changeTrackingRowKey(
        row.team_id,
        row.url,
        row.tag,
      ) as unknown as string,
      // Required by Mutation.parse -- without it the entry carries no
      // setCell mutations.
      method: "insert" as const,
      data: {
        [FAMILY]: {
          [QUALIFIER]: {
            value: row.job_id,
            timestamp: row.date_added,
          },
        },
      },
    })),
  );
}

export async function changeTrackingInsertScrapeBigtable(
  row: ChangeTrackingScrapeRow,
): Promise<void> {
  await changeTrackingInsertScrapesBigtable([row]);
}

type ChangeTrackingLastScrape = {
  job_id: string;
  /** date_added of the winning cell, as an ISO string. */
  date_added: string;
};

/**
 * Point lookup of the latest scrape for (team_id, url, tag). Returns null
 * when the team never scraped this url+tag combination.
 */
export async function changeTrackingGetLastScrapeBigtable(params: {
  team_id: string;
  url: string;
  tag: string | null;
}): Promise<ChangeTrackingLastScrape | null> {
  const table = await ensureChangeTrackingTable();
  const key = changeTrackingRowKey(params.team_id, params.url, params.tag);
  const [rows] = await table.getRows({
    keys: [key as unknown as string],
    // Qualifier regex + latest-version-only, expressed via the column
    // filter's cellLimit (there is no standalone `versions` filter key).
    filter: [{ column: { name: QUALIFIER, cellLimit: 1 } }],
  });
  const row = rows[0];
  if (!row) return null;
  const cells = row.data?.[FAMILY]?.[QUALIFIER];
  const cell = Array.isArray(cells) ? cells[0] : undefined;
  if (!cell || cell.value == null) return null;
  // Cell timestamps are microseconds, delivered as string or number
  // (protos render >32-bit longs as strings). Both are safe integers in
  // JS until ~year 2255.
  const timestampMicros = Number(cell.timestamp);
  const dateAdded = new Date(
    Number.isFinite(timestampMicros)
      ? Math.floor(timestampMicros / 1000)
      : Date.now(),
  );
  return {
    job_id: String(cell.value),
    date_added: dateAdded.toISOString(),
  };
}

// ============================================================================
// Backend routing
// ============================================================================

type ChangeTrackingWriteBackend = "postgres" | "bigtable" | "dual";

let warnedFallback = false;

/**
 * Which store(s) log_job should write to. bigtable/dual degrade to
 * postgres when Bigtable is not configured so a bad env cannot silently
 * disable change tracking.
 */
export function changeTrackingWriteBackend(): ChangeTrackingWriteBackend {
  const backend = config.CHANGE_TRACKING_BACKEND;
  if (backend !== "postgres" && !changeTrackingBigtableConfigured()) {
    if (!warnedFallback) {
      warnedFallback = true;
      logger.warn(
        "CHANGE_TRACKING_BACKEND is set to use Bigtable but BIGTABLE_INSTANCE_ID is not configured; falling back to postgres",
      );
    }
    return "postgres";
  }
  return backend;
}

/** Which store deriveDiff should read from. dual reads postgres until flip. */
export function changeTrackingReadBackend(): "postgres" | "bigtable" {
  return changeTrackingWriteBackend() === "bigtable" ? "bigtable" : "postgres";
}
