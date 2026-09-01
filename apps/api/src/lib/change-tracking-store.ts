import type { Bigtable, Table } from "@google-cloud/bigtable";
import crypto from "crypto";
import { config } from "../config";
import { logger } from "./logger";
import {
  changeTrackingInsertScrape as changeTrackingInsertScrapeRpc,
  diffGetLastScrape,
} from "../db/rpc";

// Change tracking bookkeeping. Migration step 1 (#4475 is the intended
// endpoint): Postgres stays the primary store -- writes go to
// change_tracking_scrapes, reads come from it -- and, when Bigtable is
// configured, every write is double-written to the Bigtable layout the
// endpoint uses: one row per (team_id, url, tag) holding the latest
// scrape's job id, cell timestamp = date_added, family GC max_versions=1.
// The Bigtable side is never read yet; its writes are detached and
// best-effort.
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

function bigtableConfigured(): boolean {
  return !!config.BIGTABLE_INSTANCE_ID;
}

let bigtableClient: Bigtable | null = null;
let table: Table | null = null;

// The Bigtable package is loaded lazily: log_job imports this module on
// the primary scrape-logging path, so a broken or slow package load must
// never take that path down -- failures surface only in the double-write.
async function getChangeTrackingTable(): Promise<Table> {
  if (!bigtableClient) {
    const { Bigtable } = await import("@google-cloud/bigtable");
    bigtableClient = new Bigtable({
      projectId: config.BIGTABLE_PROJECT_ID,
      ...(config.BIGTABLE_APP_PROFILE_ID
        ? { appProfileId: config.BIGTABLE_APP_PROFILE_ID }
        : {}),
      // The client's Cloud Monitoring metrics handler requires the
      // OTel 1.x line, which GHSA-8988-4f7v-96qf only patches on 2.x;
      // we don't consume client-side metrics, so disable the handler
      // and let the dependency overrides move the tree to 2.x.
      metricsEnabled: false,
    });
  }
  if (!table) {
    table = bigtableClient
      .instance(config.BIGTABLE_INSTANCE_ID!)
      .table(TABLE_ID);
  }
  return table;
}

// The double-write is best-effort: it runs detached with a bounded
// timeout so a slow or hung Bigtable can never add failure latency to
// the already-successful Postgres write.
const BIGTABLE_DOUBLE_WRITE_TIMEOUT_MS = 10_000;

function doubleWriteToBigtable(params: {
  team_id: string;
  url: string;
  job_id: string;
  tag: string | null;
  date_added: Date;
}): void {
  void (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const write = getChangeTrackingTable().then(table =>
        // Runtime accepts Buffer keys (converted verbatim); the .d.ts
        // only declares string.
        table.mutate([
          {
            key: changeTrackingRowKey(
              params.team_id,
              params.url,
              params.tag,
            ) as unknown as string,
            // Required by Mutation.parse -- without it the entry
            // carries no setCell mutations.
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
        ]),
      );
      // Keep the write handled in case the race below settles on the
      // timeout first and it rejects later.
      write.catch(() => {});
      await Promise.race([
        write,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Bigtable change tracking double-write timed out after ${BIGTABLE_DOUBLE_WRITE_TIMEOUT_MS}ms`,
                ),
              ),
            BIGTABLE_DOUBLE_WRITE_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } catch (error) {
      logger.warn("Error inserting change tracking record into Bigtable", {
        error,
        teamId: params.team_id,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
}

export async function changeTrackingInsertScrape(params: {
  team_id: string;
  url: string;
  job_id: string;
  tag: string | null;
  /** When the scrape was logged; becomes the cell timestamp. */
  date_added: Date;
}): Promise<void> {
  await changeTrackingInsertScrapeRpc({
    team_id: params.team_id,
    url: params.url,
    job_id: params.job_id,
    change_tracking_tag: params.tag,
    date_added: params.date_added.toISOString(),
  });

  if (bigtableConfigured()) {
    doubleWriteToBigtable(params);
  }
}

/**
 * Point lookup of the latest scrape for (team_id, url, tag). Returns null
 * when the team never scraped this url+tag combination.
 */
export async function changeTrackingGetLastScrape(params: {
  team_id: string;
  url: string;
  tag: string | null;
}): Promise<{ job_id: string; date_added: string } | null> {
  const rows = await diffGetLastScrape(params.team_id, params.url, params.tag);
  const row = rows[0];
  if (!row) return null;
  return {
    job_id: row.o_job_id,
    date_added: new Date(row.o_date_added).toISOString(),
  };
}
