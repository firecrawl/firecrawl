import crypto from "crypto";
import { config } from "../config";
import { diffGetLastScrape } from "../db/rpc";
import { getBigtableTable } from "./bigtable-client";
import { setSpanAttributes, withSpan } from "./otel-tracer";

// Change tracking bookkeeping. Final architecture (#4484 was the
// transition): Bigtable is the store. Writes go to Bigtable only --
// no Postgres insert. Reads are Bigtable-primary with a Postgres
// fallback on miss: every Bigtable row was written after the cutover,
// so it is at least as recent as any Postgres row for the same key,
// and a miss means the latest scrape predates the cutover, which the
// frozen Postgres archive still holds. Drop the archive once the
// fallback read rate decays to ~0. Bigtable errors do not fall back --
// they surface through the existing deriveDiff warning.
//
// One row per (team_id, url, tag) holding the latest scrape's job id;
// content itself lives in GCS. Cell timestamp = date_added, family GC
// rule max_versions=1, so reads return the highest date_added and
// regressed (out-of-order) writes are shadowed then collected at
// compaction.
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

function changeTrackingRowKey(
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

export async function changeTrackingInsertScrape(params: {
  team_id: string;
  url: string;
  job_id: string;
  tag: string | null;
  /** When the scrape was logged; becomes the cell timestamp. */
  date_added: Date;
}): Promise<void> {
  await withSpan("bigtable.change_tracking.write", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": TABLE_ID,
      "bigtable.operation": "mutate",
    });
    const table = await getBigtableTable(TABLE_ID);
    // Runtime accepts Buffer keys (converted verbatim); the .d.ts only
    // declares string.
    await table.mutate([
      {
        key: changeTrackingRowKey(
          params.team_id,
          params.url,
          params.tag,
        ) as unknown as string,
        // Required by Mutation.parse -- without it the entry carries no
        // setCell mutations.
        method: "insert" as const,
        data: {
          [FAMILY]: {
            [QUALIFIER]: {
              value: params.job_id,
              timestamp: params.date_added,
            },
          },
        },
      },
    ]);
  });
}

/**
 * Point lookup of the latest scrape for (team_id, url, tag). Bigtable is
 * primary; a miss falls back to the frozen Postgres archive, which holds
 * pre-cutover history. Returns null when the team never scraped this
 * url+tag combination.
 */
export async function changeTrackingGetLastScrape(params: {
  team_id: string;
  url: string;
  tag: string | null;
}): Promise<{ job_id: string; date_added: string } | null> {
  const table = await getBigtableTable(TABLE_ID);
  const key = changeTrackingRowKey(params.team_id, params.url, params.tag);
  const rows = await withSpan("bigtable.change_tracking.read", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": TABLE_ID,
      "bigtable.operation": "getRows",
    });
    const [result] = await table.getRows({
      keys: [key as unknown as string],
      // Qualifier regex + latest-version-only, expressed via the column
      // filter's cellLimit (there is no standalone `versions` filter key).
      filter: [{ column: { name: QUALIFIER, cellLimit: 1 } }],
    });
    setSpanAttributes(span, {
      "bigtable.rows_returned": result.length,
    });
    return result;
  });
  const row = rows[0];
  if (row) {
    const cells = row.data?.[FAMILY]?.[QUALIFIER];
    const cell = Array.isArray(cells) ? cells[0] : undefined;
    if (cell && cell.value != null) {
      // Cell timestamps are microseconds, delivered as string or number
      // (protos render >32-bit longs as strings). Both are safe
      // integers in JS until ~year 2255.
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
  }

  // Bigtable miss: the latest scrape for this key predates the cutover.
  const pgRows = await diffGetLastScrape(
    params.team_id,
    params.url,
    params.tag,
  );
  const pgRow = pgRows[0];
  if (!pgRow) return null;
  return {
    job_id: pgRow.o_job_id,
    date_added: new Date(pgRow.o_date_added).toISOString(),
  };
}
