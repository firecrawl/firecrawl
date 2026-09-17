import { beforeEach, describe, expect, it, vi } from "vitest";

const { request, getRows, getBigtableTable, mutableConfig, withSpan } =
  vi.hoisted(() => ({
    request: vi.fn(),
    getRows: vi.fn(),
    getBigtableTable: vi.fn(),
    mutableConfig: {
      BIGTABLE_REQUEST_CREDITS_TABLE: "request-credits" as string | undefined,
    },
    withSpan: vi.fn(async (_name: string, fn: (span: object) => unknown) =>
      fn({ setAttributes: vi.fn() }),
    ),
  }));

vi.mock("../config", () => ({ config: mutableConfig }));
vi.mock("./bigtable-client", () => ({ getBigtableTable }));
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes: vi.fn(),
}));

import {
  clearRequestCreditsShardCacheForTest,
  initializeRequestCredits,
  readRequestCredits,
  recordRequestCredits,
  requestCreditsRowKey,
  requestCreditsShardForJob,
  requestCreditsShards,
} from "./request-credits-store";

function row(data: Record<string, unknown>) {
  return { data };
}

function int64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(value);
  return buffer;
}

describe("request credits store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRequestCreditsShardCacheForTest();
    mutableConfig.BIGTABLE_REQUEST_CREDITS_TABLE = "request-credits";
    getBigtableTable.mockResolvedValue({
      name: "projects/p/instances/i/tables/request-credits",
      bigtable: { appProfileId: "single-cluster", request },
      getRows,
    });
    request.mockImplementation((_options, callback) =>
      callback(null, { predicateMatched: false }),
    );
  });

  it("uses stable salted request and job shards", () => {
    expect(requestCreditsRowKey("not-a-uuid", 3)).toBe(
      requestCreditsRowKey("not-a-uuid", 3),
    );
    expect(requestCreditsRowKey("not-a-uuid", 3)).not.toBe(
      requestCreditsRowKey("not-a-uuid", 4),
    );
    expect(requestCreditsShardForJob("job-1", 16)).toBeLessThan(16);
    expect(requestCreditsShardForJob("job-1", 16)).toBe(
      requestCreditsShardForJob("job-1", 16),
    );
  });

  it("caps shard selection at 512", () => {
    expect(requestCreditsShards(1_000)).toBe(8);
    expect(requestCreditsShards(10_000)).toBe(16);
    expect(requestCreditsShards(100_000)).toBe(64);
    expect(requestCreditsShards(1_000_000)).toBe(512);
    expect(requestCreditsShards(10_000_000)).toBe(512);
  });

  it("initializes shard zero exactly once", async () => {
    await expect(initializeRequestCredits("request-1", 16)).resolves.toBe(true);

    const call = request.mock.calls[0][0];
    expect(call).toMatchObject({
      client: "BigtableClient",
      method: "checkAndMutateRow",
      reqOpts: {
        tableName: "projects/p/instances/i/tables/request-credits",
        appProfileId: "single-cluster",
        falseMutations: [
          {
            setCell: {
              familyName: "jobs",
              columnQualifier: Buffer.from("\x00shards"),
              timestampMicros: 0,
              value: Buffer.from("16"),
            },
          },
        ],
      },
    });
  });

  it("atomically records one job marker and aggregate addition", async () => {
    await initializeRequestCredits("request-1", 8);
    request.mockClear();

    await expect(
      recordRequestCredits({
        requestId: "request-1",
        jobId: "job-1",
        credits: 7,
      }),
    ).resolves.toBe(true);

    const mutations = request.mock.calls[0][0].reqOpts.falseMutations;
    expect(mutations).toEqual([
      {
        setCell: {
          familyName: "jobs",
          columnQualifier: Buffer.from("job-1"),
          timestampMicros: 0,
          value: Buffer.from("7"),
        },
      },
      {
        addToCell: {
          familyName: "agg",
          columnQualifier: { rawValue: Buffer.from("total") },
          timestamp: { rawTimestampMicros: 0 },
          input: { intValue: 7 },
        },
      },
    ]);
  });

  it("reports a duplicate without another logical addition", async () => {
    await initializeRequestCredits("request-1", 8);
    request.mockImplementation((_options, callback) =>
      callback(null, { predicateMatched: true }),
    );
    getRows.mockResolvedValueOnce([
      [row({ jobs: { "job-1": [{ value: Buffer.from("7") }] } })],
    ]);

    await expect(
      recordRequestCredits({
        requestId: "request-1",
        jobId: "job-1",
        credits: 7,
      }),
    ).resolves.toBe(false);
  });

  it("reads and sums all aggregate shard cells", async () => {
    getRows
      .mockResolvedValueOnce([
        [row({ jobs: { "\x00shards": [{ value: Buffer.from("2") }] } })],
      ])
      .mockResolvedValueOnce([
        [
          row({ agg: { total: [{ value: int64(7n) }] } }),
          row({ agg: { total: [{ value: int64(5n) }] } }),
        ],
      ]);

    await expect(readRequestCredits("request-1")).resolves.toBe(12);
    expect(getRows.mock.calls[1][0].keys).toEqual([
      requestCreditsRowKey("request-1", 0),
      requestCreditsRowKey("request-1", 1),
    ]);
  });

  it("is disabled when the table is not configured", async () => {
    mutableConfig.BIGTABLE_REQUEST_CREDITS_TABLE = undefined;

    await expect(initializeRequestCredits("request-1", 8)).resolves.toBe(false);
    await expect(
      recordRequestCredits({
        requestId: "request-1",
        jobId: "job-1",
        credits: 1,
      }),
    ).resolves.toBe(false);
    await expect(readRequestCredits("request-1")).resolves.toBeNull();
    expect(getBigtableTable).not.toHaveBeenCalled();
  });
});
