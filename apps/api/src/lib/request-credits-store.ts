import crypto from "node:crypto";
import type { Table } from "@google-cloud/bigtable";
import { config } from "../config";
import { getBigtableTable } from "./bigtable-client";
import { setSpanAttributes, withSpan } from "./otel-tracer";

const JOBS_FAMILY = "jobs";
const AGG_FAMILY = "agg";
const TOTAL_QUALIFIER = "total";
const SHARDS_QUALIFIER = "\x00shards";
const FIXED_TIMESTAMP_MICROS = 0;
const MAX_CACHED_SHARD_COUNTS = 10_000;
const shardCounts = new Map<string, number>();

function cacheShardCount(requestId: string, shards: number): void {
  shardCounts.delete(requestId);
  shardCounts.set(requestId, shards);
  if (shardCounts.size > MAX_CACHED_SHARD_COUNTS) {
    const oldest = shardCounts.keys().next().value;
    if (oldest !== undefined) shardCounts.delete(oldest);
  }
}

/**
 * Restore the raw bytes of a cell value read with `decode: false`.
 *
 * The Bigtable client converts any 8-byte value that fits a safe integer into
 * a JavaScript number *before* it honours `decode: false`, so the `agg:total`
 * Int64 aggregate (and, in principle, an 8-character text cell) arrives as a
 * number. The conversion is `Long.fromBytes(buf).toNumber()`, which is exact
 * for safe integers, so writing the number back as a big-endian Int64 yields
 * the original bytes.
 */
export function cellBytes(
  value: Buffer | Uint8Array | string | number,
): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Unexpected non-integer Bigtable cell value: ${value}`);
    }
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(value));
    return buffer;
  }
  return Buffer.from(value as any);
}

function requestHash(requestId: string): Buffer {
  return crypto.createHash("sha256").update(requestId, "utf8").digest();
}

export function requestCreditsRowKey(requestId: string, shard: number): string {
  if (!Number.isInteger(shard) || shard < 0 || shard > 0xffff) {
    throw new Error(`Invalid request credits shard: ${shard}`);
  }

  const hash = requestHash(requestId);
  const shardBytes = Buffer.allocUnsafe(2);
  shardBytes.writeUInt16BE(shard);
  const salt = crypto
    .createHash("sha256")
    .update(hash)
    .update(shardBytes)
    .digest()
    .subarray(0, 2)
    .toString("hex");
  return `${salt}#${hash.toString("hex")}#${shard}`;
}

export function requestCreditsShardForJob(
  jobId: string,
  shards: number,
): number {
  if (!Number.isInteger(shards) || shards <= 0 || shards > 512) {
    throw new Error(`Invalid request credits shard count: ${shards}`);
  }
  return (
    crypto.createHash("sha256").update(jobId, "utf8").digest().readUInt16BE(0) %
    shards
  );
}

/**
 * Shard count for an agent request's credit row. An agent's job count is not
 * known up front, and every writer that may create the row for an agent id
 * (the agent controller, and agent-interop calls that reach the API first)
 * must agree on it, because the row is created once and never resized.
 */
export const AGENT_REQUEST_CREDITS_SHARDS = 8;

export function requestCreditsShards(maxJobs: number): number {
  if (!Number.isFinite(maxJobs) || maxJobs <= 0) return 8;
  if (maxJobs <= 1_000) return 8;
  if (maxJobs <= 10_000) return 16;
  if (maxJobs <= 100_000) return 64;
  return 512;
}

function exactQualifierFilter(qualifier: string) {
  return {
    chain: {
      filters: [
        { familyNameRegexFilter: `^${JOBS_FAMILY}$` },
        {
          columnQualifierRegexFilter: Buffer.concat([
            Buffer.from("^"),
            Buffer.from(qualifier),
            Buffer.from("$"),
          ]),
        },
      ],
    },
  };
}

async function checkAndMutateRowOnce(
  table: Table,
  request: Record<string, unknown>,
): Promise<{ predicateMatched?: boolean | null }> {
  return new Promise((resolve, reject) => {
    table.bigtable.request(
      {
        client: "BigtableClient",
        method: "checkAndMutateRow",
        reqOpts: {
          tableName: table.name,
          appProfileId: table.bigtable.appProfileId,
          ...request,
        },
      },
      (
        error: Error | null,
        response?: { predicateMatched?: boolean | null },
      ) => {
        if (error) reject(error);
        else resolve(response ?? {});
      },
    );
  });
}

async function checkAndMutateRow(
  table: Table,
  request: Record<string, unknown>,
): Promise<{ predicateMatched?: boolean | null }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await checkAndMutateRowOnce(table, request);
    } catch (error) {
      lastError = error;
      const code =
        error && typeof error === "object"
          ? (error as { code?: unknown }).code
          : undefined;
      if (![1, 2, 4, 8, 10, 13, 14].includes(Number(code))) throw error;
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function setCellMutation(qualifier: string, value: Buffer) {
  return {
    setCell: {
      familyName: JOBS_FAMILY,
      columnQualifier: Buffer.from(qualifier),
      timestampMicros: FIXED_TIMESTAMP_MICROS,
      value,
    },
  };
}

async function readShardCount(
  table: Table,
  requestId: string,
): Promise<number | null> {
  const [rows] = await table.getRows({
    keys: [requestCreditsRowKey(requestId, 0)],
    decode: false,
    filter: [
      { family: JOBS_FAMILY },
      { column: SHARDS_QUALIFIER, cellLimit: 1 },
    ],
  });
  const value = rows[0]?.data?.[JOBS_FAMILY]?.[SHARDS_QUALIFIER]?.[0]?.value;
  if (value == null) return null;
  const shards = Number(cellBytes(value).toString("utf8"));
  if (!Number.isInteger(shards) || shards <= 0 || shards > 512) {
    throw new Error(`Invalid stored request credits shard count: ${shards}`);
  }
  cacheShardCount(requestId, shards);
  return shards;
}

async function getShardCount(
  table: Table,
  requestId: string,
): Promise<number | null> {
  return shardCounts.get(requestId) ?? readShardCount(table, requestId);
}

async function readJobCredits(
  table: Table,
  rowKey: string,
  jobId: string,
): Promise<number | null> {
  const [rows] = await table.getRows({
    keys: [rowKey],
    decode: false,
    filter: [{ family: JOBS_FAMILY }, { column: jobId, cellLimit: 1 }],
  });
  const value = rows[0]?.data?.[JOBS_FAMILY]?.[jobId]?.[0]?.value;
  if (value == null) return null;
  const credits = Number(cellBytes(value).toString("utf8"));
  if (!Number.isSafeInteger(credits)) {
    throw new Error(`Invalid stored request credits value: ${credits}`);
  }
  return credits;
}

export async function initializeRequestCredits(
  requestId: string,
  shards: number,
): Promise<boolean> {
  const tableId = config.BIGTABLE_REQUEST_CREDITS_TABLE;
  if (!tableId) return false;
  if (!Number.isInteger(shards) || shards <= 0 || shards > 512) {
    throw new Error(`Invalid request credits shard count: ${shards}`);
  }

  return withSpan("bigtable.request_credits.initialize", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.operation": "checkAndMutateRow",
      "request_credits.shards": shards,
    });
    const table = await getBigtableTable(tableId);
    const response = await checkAndMutateRow(table, {
      rowKey: Buffer.from(requestCreditsRowKey(requestId, 0)),
      predicateFilter: exactQualifierFilter(SHARDS_QUALIFIER),
      falseMutations: [
        setCellMutation(SHARDS_QUALIFIER, Buffer.from(String(shards))),
      ],
    });
    const stored = response.predicateMatched
      ? await readShardCount(table, requestId)
      : shards;
    if (stored !== shards) {
      throw new Error(
        `Request credits shard count mismatch for ${requestId}: ${stored} != ${shards}`,
      );
    }
    cacheShardCount(requestId, shards);
    return true;
  });
}

export async function recordRequestCredits(params: {
  requestId: string;
  jobId: string;
  credits: number;
}): Promise<boolean> {
  const tableId = config.BIGTABLE_REQUEST_CREDITS_TABLE;
  if (!tableId) return false;
  if (!Number.isSafeInteger(params.credits)) {
    throw new Error(`Invalid request credits value: ${params.credits}`);
  }

  return withSpan("bigtable.request_credits.record", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.operation": "checkAndMutateRow",
      "request_credits.value": params.credits,
    });
    const table = await getBigtableTable(tableId);
    const shards = await getShardCount(table, params.requestId);
    if (shards === null) return false;
    const shard = requestCreditsShardForJob(params.jobId, shards);
    const rowKey = requestCreditsRowKey(params.requestId, shard);
    const response = await checkAndMutateRow(table, {
      rowKey: Buffer.from(rowKey),
      predicateFilter: exactQualifierFilter(params.jobId),
      falseMutations: [
        setCellMutation(params.jobId, Buffer.from(String(params.credits))),
        {
          addToCell: {
            familyName: AGG_FAMILY,
            columnQualifier: { rawValue: Buffer.from(TOTAL_QUALIFIER) },
            timestamp: { rawTimestampMicros: FIXED_TIMESTAMP_MICROS },
            input: { intValue: params.credits },
          },
        },
      ],
    });
    setSpanAttributes(span, {
      "request_credits.shard": shard,
      "request_credits.duplicate": response.predicateMatched === true,
    });
    if (response.predicateMatched !== true) return true;

    const storedCredits = await readJobCredits(table, rowKey, params.jobId);
    if (storedCredits !== params.credits) {
      throw new Error(
        `Request credits mismatch for ${params.jobId}: ${storedCredits} != ${params.credits}`,
      );
    }
    return false;
  });
}

export async function readRequestCredits(
  requestId: string,
): Promise<number | null> {
  const tableId = config.BIGTABLE_REQUEST_CREDITS_TABLE;
  if (!tableId) return null;

  return withSpan("bigtable.request_credits.read", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.operation": "getRows",
    });
    const table = await getBigtableTable(tableId);
    const shards = await getShardCount(table, requestId);
    if (shards === null) return null;
    const [rows] = await table.getRows({
      keys: Array.from({ length: shards }, (_, shard) =>
        requestCreditsRowKey(requestId, shard),
      ),
      decode: false,
      filter: [
        { family: AGG_FAMILY },
        { column: TOTAL_QUALIFIER, cellLimit: 1 },
      ],
    });
    let total = 0n;
    for (const row of rows) {
      const value = row.data?.[AGG_FAMILY]?.[TOTAL_QUALIFIER]?.[0]?.value;
      if (value == null) continue;
      const encoded = cellBytes(value);
      if (encoded.length !== 8) {
        throw new Error(
          `Invalid request credits aggregate length: ${encoded.length}`,
        );
      }
      total += encoded.readBigInt64BE();
    }
    const credits = Number(total);
    if (!Number.isSafeInteger(credits)) {
      throw new Error(`Request credits total exceeds safe integer: ${total}`);
    }
    setSpanAttributes(span, {
      "request_credits.shards": shards,
      "request_credits.returned_rows": rows.length,
      "request_credits.total": credits,
    });
    return credits;
  });
}

export function clearRequestCreditsShardCacheForTest(): void {
  shardCounts.clear();
}
