import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { getBigtableTable } from "../../lib/bigtable-client";
import { logger } from "../../lib/logger";
import { cellBytes, checkAndMutateRow } from "../../lib/request-credits-store";
import { redisRateLimitClient } from "../rate-limiter";
import type { ExchangeResponse } from "./contracts";

// One record per charge id (team + x-request-id), written before the provider
// call so a crash is found as unresolved instead of re-executed, and rewritten
// when the request completes so a repeat never executes twice. The response
// itself is kept apart, in the response cache.
export type Retrieval = {
  fingerprint: string;
  phase: "executing" | "done";
  deadline: number;
  scrapeId: string;
  lockId?: string;
  maximumCredits?: number;
  // When the request completed. Absent on records written before it was recorded.
  doneAt?: number;
  // Only on completed records written before responses moved to the response cache.
  response?: ExchangeResponse;
  // Whether the response went into the response cache when the request completed.
  responseKept?: boolean;
  // Set instead of response under zero data retention.
  responseWithheld?: boolean;
  failure?: string;
};

type Claim =
  | { claimed: true }
  // The record already there, or null when it has gone since the claim lost.
  | { claimed: false; existing: Retrieval | null };

type ReplayStore = {
  /** Takes the charge id for this record unless a record already holds it. */
  claim(record: Retrieval): Promise<Claim>;
  write(record: Retrieval): Promise<void>;
  /** Drops the record, so the same charge id can be claimed again. */
  release(): Promise<void>;
};

const RETENTION_SECONDS = 7 * 86400;

const redisStore = (id: string): ReplayStore => {
  const key = `alexandria:retrieve:${id}`;
  return {
    async claim(record) {
      const claimed = await redisRateLimitClient.set(
        key,
        JSON.stringify(record),
        "EX",
        RETENTION_SECONDS,
        "NX",
      );
      if (claimed === "OK") return { claimed: true };
      const raw = await redisRateLimitClient.get(key);
      return { claimed: false, existing: raw ? JSON.parse(raw) : null };
    },
    async write(record) {
      await redisRateLimitClient.set(
        key,
        JSON.stringify(record),
        "EX",
        RETENTION_SECONDS,
      );
    },
    async release() {
      await redisRateLimitClient.del(key);
    },
  };
};

// In Bigtable a record is one cell in a row keyed by the charge id. The cell's timestamp
// is the instant it expires, which the table's garbage collection acts on; collection
// lags, so the record repeats that instant for readers.
const FAMILY = "s";
const QUALIFIER = "v";
const RETENTION_MS = RETENTION_SECONDS * 1000;
// A call that has not answered by then fails, so a slow table holds a request only so long.
// The claim is retried, so it gets less per attempt.
const CLAIM_ATTEMPT_TIMEOUT_MS = 2000;
const gaxOptions = { timeout: 5000 };

type Stored = Omit<Retrieval, "response"> & {
  version: 1;
  expiresAt: number;
  // Which request wrote the record, so a claim whose answer was lost and retried can tell
  // its own record from another request's.
  owner: string;
  // Written beside the Redis record that still decides; see mirroredStore.
  copy?: true;
};

const bigtableStore = (id: string, tableId: string, copy: boolean) => {
  const owner = randomUUID();
  const cell = (record: Retrieval, now: number) => {
    const { response: _, ...state } = record;
    const stored: Stored = {
      ...state,
      version: 1,
      expiresAt: now + RETENTION_MS,
      owner,
      ...(copy ? { copy: true as const } : {}),
    };
    return Buffer.from(JSON.stringify(stored));
  };

  const read = async (): Promise<{
    record: Retrieval;
    owner: string;
    copy: boolean;
  } | null> => {
    const table = await getBigtableTable(tableId);
    let rows;
    try {
      [rows] = await table.getRows({
        keys: [id],
        decode: false,
        filter: [{ family: FAMILY }, { column: { cellLimit: 1 } }],
        gaxOptions,
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 5 || code === 404) return null;
      throw error;
    }
    const value = rows[0]?.data?.[FAMILY]?.[QUALIFIER]?.[0]?.value;
    if (value == null) return null;
    const {
      version: _,
      expiresAt,
      owner: writer,
      copy: copied,
      ...record
    } = JSON.parse(cellBytes(value).toString("utf8")) as Stored;
    if (expiresAt <= Date.now()) return null;
    return { record, owner: writer, copy: copied === true };
  };

  // Takes back a claim whose answer never arrived. Without it the charge id would stay
  // held, for the record's whole life, by a request that did not run.
  const abandon = async () => {
    const table = await getBigtableTable(tableId);
    await checkAndMutateRow(
      table,
      {
        rowKey: Buffer.from(id),
        // The row's record is this request's own.
        predicateFilter: {
          chain: {
            filters: [
              { familyNameRegexFilter: `^${FAMILY}$` },
              { valueRegexFilter: Buffer.from(`.*"owner":"${owner}".*`) },
            ],
          },
        },
        trueMutations: [{ deleteFromRow: {} }],
      },
      { timeout: CLAIM_ATTEMPT_TIMEOUT_MS },
    );
  };

  const claim = async (
    record: Retrieval,
  ): Promise<Claim & { copy?: boolean }> => {
    const now = Date.now();
    const table = await getBigtableTable(tableId);
    const { predicateMatched } = await checkAndMutateRow(
      table,
      {
        rowKey: Buffer.from(id),
        // A cell that has not expired yet.
        predicateFilter: {
          chain: {
            filters: [
              { familyNameRegexFilter: `^${FAMILY}$` },
              { timestampRangeFilter: { startTimestampMicros: now * 1000 } },
            ],
          },
        },
        falseMutations: [
          {
            setCell: {
              familyName: FAMILY,
              columnQualifier: Buffer.from(QUALIFIER),
              timestampMicros: (now + RETENTION_MS) * 1000,
              value: cell(record, now),
            },
          },
        ],
      },
      { timeout: CLAIM_ATTEMPT_TIMEOUT_MS },
    );
    if (!predicateMatched) return { claimed: true };
    const existing = await read();
    if (existing?.owner === owner) return { claimed: true };
    return {
      claimed: false,
      existing: existing?.record ?? null,
      copy: existing?.copy,
    };
  };

  return {
    async claim(record: Retrieval) {
      try {
        return await claim(record);
      } catch (error) {
        await abandon().catch(cleanup =>
          logger.error(
            "Alexandria claim could not be taken back; its charge id may stay held",
            { chargeId: id, error: cleanup },
          ),
        );
        throw error;
      }
    },
    async write(record: Retrieval) {
      const now = Date.now();
      const table = await getBigtableTable(tableId);
      await table.mutate(
        [
          {
            key: id,
            method: "insert",
            data: {
              [FAMILY]: {
                [QUALIFIER]: {
                  value: cell(record, now),
                  timestamp: new Date(now + RETENTION_MS),
                },
              },
            },
          },
        ],
        { gaxOptions },
      );
    },
    async release() {
      const table = await getBigtableTable(tableId);
      await table.mutate([{ key: id, method: "delete" }], { gaxOptions });
    },
  };
};

const COPY_CLAIM_TIMEOUT_MS = 500;
const within = <T>(ms: number, work: Promise<T>): Promise<T | undefined> => {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Redis decides, as it does on pods that know nothing of Bigtable, and every write is copied
// to Bigtable so the table can be watched before anything depends on it. Copies run one
// after another behind the request, and only once this request's own claim has reached the
// row, so they never replace a row another request holds. A copy that fails is logged and
// never fails the request, so a copy can be stale and is never trusted here.
// The one Bigtable record that is trusted is one written by a pod that keeps the record in
// Bigtable alone: such a pod never wrote to Redis, so its record is the request's only one.
// Finding it is the one thing the request waits on Bigtable for, and for half a second at
// most: past that it goes ahead on Redis's word.
const mirroredStore = (id: string, tableId: string): ReplayStore => {
  const redis = redisStore(id);
  const bigtable = bigtableStore(id, tableId, true);
  let last: Promise<unknown> = Promise.resolve();
  let owns = false;
  const copy = <T>(step: string, work: () => Promise<T>) => {
    const done = last.then(work).catch(error => {
      logger.warn("Alexandria replay record was not copied to Bigtable", {
        chargeId: id,
        step,
        error,
      });
      return undefined;
    });
    last = done;
    return done;
  };
  return {
    async claim(record) {
      const claim = await redis.claim(record);
      if (!claim.claimed) return claim;
      const copied = await within(
        COPY_CLAIM_TIMEOUT_MS,
        copy("claim", async () => {
          const result = await bigtable.claim(record);
          const trusted =
            !result.claimed && result.existing !== null && !result.copy;
          // Anything else found there is a copy Redis no longer backs, which this
          // request's record replaces.
          if (!result.claimed && !trusted) await bigtable.write(record);
          owns = !trusted;
          return trusted ? result : undefined;
        }),
      );
      if (!copied || copied.claimed) return claim;
      await redis.release();
      return { claimed: false, existing: copied.existing };
    },
    async write(record) {
      await redis.write(record);
      void copy("write", async () => {
        if (owns) await bigtable.write(record);
      });
    },
    async release() {
      await redis.release();
      void copy("release", async () => {
        if (owns) await bigtable.release();
      });
    },
  };
};

export const replayStore = (id: string): ReplayStore =>
  config.BIGTABLE_ALEXANDRIA_REPLAY_TABLE
    ? mirroredStore(id, config.BIGTABLE_ALEXANDRIA_REPLAY_TABLE)
    : redisStore(id);
