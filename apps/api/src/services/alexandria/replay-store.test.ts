import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Cell = { micros: number; value: Buffer };

const mocks = vi.hoisted(() => {
  const redis = new Map<string, string>();
  // row key -> "family:qualifier" -> cells, newest timestamp first
  const rows = new Map<string, Map<string, Cell[]>>();
  const put = (key: string, column: string, cell: Cell) => {
    const row = rows.get(key) ?? new Map<string, Cell[]>();
    rows.set(key, row);
    const cells = (row.get(column) ?? []).filter(c => c.micros !== cell.micros);
    row.set(
      column,
      [...cells, cell].sort((a, b) => b.micros - a.micros),
    );
  };
  return {
    redis,
    rows,
    put,
    config: {
      BIGTABLE_ALEXANDRIA_REPLAY_TABLE: undefined as string | undefined,
    },
    request: vi.fn(),
    mutate: vi.fn(),
    getRows: vi.fn(),
  };
});
vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("../../lib/otel-tracer", () => ({
  withSpan: (_name: string, run: (span: object) => unknown) => run({}),
  setSpanAttributes: vi.fn(),
}));
vi.mock("../../lib/bigtable-client", () => ({
  getBigtableTable: async () => ({
    name: "projects/p/instances/i/tables/replay",
    bigtable: { appProfileId: "single-cluster", request: mocks.request },
    mutate: mocks.mutate,
    getRows: mocks.getRows,
  }),
}));
vi.mock("../rate-limiter", () => ({
  redisRateLimitClient: {
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes("NX") && mocks.redis.has(key)) return null;
      mocks.redis.set(key, value);
      return "OK";
    },
    get: async (key: string) => mocks.redis.get(key) ?? null,
    del: async (key: string) => (mocks.redis.delete(key) ? 1 : 0),
  },
}));

import { replayStore, type Retrieval } from "./replay-store";

const DAY = 86400_000;
const START = Date.parse("2026-01-01T00:00:00Z");
const ID = "a".repeat(64);
const claim: Retrieval = {
  fingerprint: "f",
  phase: "executing",
  deadline: START + 50_000,
  scrapeId: "scrape-1",
};
const done: Retrieval = {
  ...claim,
  phase: "done",
  lockId: "held",
  doneAt: START + 1_000,
};

/** The row as the fake holds it: its newest cell, decoded, and when that cell expires. */
const stored = (id = ID) => {
  const cell = mocks.rows.get(id)?.get("s:v")?.[0];
  return {
    record: cell ? JSON.parse(cell.value.toString()) : undefined,
    expiresAt: cell ? cell.micros / 1000 : undefined,
  };
};
/** A record as a pod that still decides in Redis copies it here: marked as a copy. */
const seedCopy = (record: Retrieval, now = Date.now()) =>
  mocks.put(ID, "s:v", {
    micros: (now + 7 * DAY) * 1000,
    value: Buffer.from(
      JSON.stringify({
        ...record,
        version: 1,
        expiresAt: now + 7 * DAY,
        owner: "another-request",
        copy: true,
      }),
    ),
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  mocks.redis.clear();
  mocks.rows.clear();
  mocks.config.BIGTABLE_ALEXANDRIA_REPLAY_TABLE = "replay";
  mocks.request.mockReset().mockImplementation((options, callback) => {
    const { rowKey, predicateFilter, trueMutations, falseMutations } =
      options.reqOpts;
    const [family, condition] = predicateFilter.chain.filters;
    const name = family.familyNameRegexFilter.slice(1, -1);
    const row = mocks.rows.get(rowKey.toString());
    const matches = (c: Cell) =>
      condition.timestampRangeFilter
        ? c.micros >= condition.timestampRangeFilter.startTimestampMicros
        : new RegExp(`^${condition.valueRegexFilter}$`).test(
            c.value.toString(),
          );
    const predicateMatched = [...(row ?? [])].some(
      ([column, cells]) => column.startsWith(`${name}:`) && cells.some(matches),
    );
    for (const mutation of (predicateMatched
      ? trueMutations
      : falseMutations) ?? []) {
      if (mutation.deleteFromRow) mocks.rows.delete(rowKey.toString());
      else
        mocks.put(
          rowKey.toString(),
          `${mutation.setCell.familyName}:${mutation.setCell.columnQualifier}`,
          {
            micros: mutation.setCell.timestampMicros,
            value: mutation.setCell.value,
          },
        );
    }
    callback(null, { predicateMatched });
  });
  mocks.mutate.mockReset().mockImplementation(async entries => {
    for (const entry of entries) {
      if (entry.method === "delete") {
        mocks.rows.delete(entry.key);
        continue;
      }
      for (const [family, columns] of Object.entries<any>(entry.data))
        for (const [qualifier, cell] of Object.entries<any>(columns))
          mocks.put(entry.key, `${family}:${qualifier}`, {
            micros: cell.timestamp.getTime() * 1000,
            value: cell.value,
          });
    }
  });
  mocks.getRows.mockReset().mockImplementation(async ({ keys }) => {
    const row = mocks.rows.get(keys[0]);
    if (!row) return [[]];
    const data: Record<string, Record<string, unknown[]>> = {};
    for (const [column, cells] of row) {
      const [family, qualifier] = column.split(":");
      (data[family] ??= {})[qualifier] = [
        { value: cells[0].value, timestamp: String(cells[0].micros) },
      ];
    }
    return [[{ data }]];
  });
});
afterEach(() => vi.useRealTimers());

describe("without a Bigtable table", () => {
  beforeEach(() => {
    mocks.config.BIGTABLE_ALEXANDRIA_REPLAY_TABLE = undefined;
  });

  it("keeps the record in Redis alone", async () => {
    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });
    await replayStore(ID).write(done);
    expect(await replayStore(ID).claim(claim)).toEqual({
      claimed: false,
      existing: done,
    });
    expect(mocks.rows.size).toBe(0);

    await replayStore(ID).release();
    expect(mocks.redis.size).toBe(0);
  });
});

describe("with a Bigtable table", () => {
  it("keeps the record in Bigtable alone", async () => {
    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });

    expect(mocks.redis.size).toBe(0);
    expect(stored()).toMatchObject({
      record: { ...claim, version: 1, expiresAt: START + 7 * DAY },
      expiresAt: START + 7 * DAY,
    });
    expect(stored().record).not.toHaveProperty("copy");
    expect(mocks.request.mock.calls[0][0]).toMatchObject({
      client: "BigtableClient",
      method: "checkAndMutateRow",
      gaxOpts: { timeout: 2000 },
      reqOpts: {
        tableName: "projects/p/instances/i/tables/replay",
        appProfileId: "single-cluster",
        rowKey: Buffer.from(ID),
        predicateFilter: {
          chain: {
            filters: [
              { familyNameRegexFilter: "^s$" },
              { timestampRangeFilter: { startTimestampMicros: START * 1000 } },
            ],
          },
        },
      },
    });
  });

  it("refuses a second claim and hands back the record that holds the id", async () => {
    const store = replayStore(ID);
    await store.claim(claim);
    expect(await replayStore(ID).claim(claim)).toEqual({
      claimed: false,
      existing: claim,
    });

    await store.write(done);
    expect(await replayStore(ID).claim(claim)).toEqual({
      claimed: false,
      existing: done,
    });
  });

  it("never stores a response a record still carries", async () => {
    const store = replayStore(ID);
    await store.claim(claim);
    await store.write({ ...done, response: { status: 200, body: "kept" } });
    expect(stored().record).not.toHaveProperty("response");
  });

  it("claims over a record that has expired but not been collected yet", async () => {
    const store = replayStore(ID);
    await store.claim(claim);
    await store.write(done);
    vi.setSystemTime(START + 7 * DAY + 1);

    const again = { ...claim, scrapeId: "scrape-2" };
    expect(await replayStore(ID).claim(again)).toEqual({ claimed: true });
    expect(await replayStore(ID).claim(again)).toEqual({
      claimed: false,
      existing: again,
    });
  });

  it("frees the id on release", async () => {
    const store = replayStore(ID);
    await store.claim(claim);
    await store.release();
    expect(mocks.rows.size).toBe(0);
    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });
  });

  it("recognises its own claim when the first answer was lost and the claim retried", async () => {
    const apply = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementationOnce((options, callback) =>
      apply(options, () =>
        callback(Object.assign(new Error("deadline"), { code: 4 })),
      ),
    );

    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("takes back a claim whose answer never arrived, so the id is not left held", async () => {
    const down = Object.assign(new Error("unavailable"), { code: 7 });
    const apply = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementationOnce((options, callback) =>
      apply(options, () => callback(down)),
    );

    await expect(replayStore(ID).claim(claim)).rejects.toBe(down);
    expect(mocks.rows.size).toBe(0);
    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });
  });

  it("leaves another request's record alone when its own claim fails", async () => {
    seedCopy(done);
    const down = Object.assign(new Error("unavailable"), { code: 7 });
    mocks.getRows.mockRejectedValueOnce(down);

    await expect(replayStore(ID).claim(claim)).rejects.toBe(down);
    expect(stored().record.owner).toBe("another-request");
  });

  it("honours a record a pod that still decides in Redis copied here", async () => {
    seedCopy(done);

    expect(await replayStore(ID).claim(claim)).toEqual({
      claimed: false,
      existing: done,
    });
  });

  it("fails the claim, the write and the release when Bigtable fails", async () => {
    const down = Object.assign(new Error("unavailable"), { code: 7 });
    const store = replayStore(ID);
    await store.claim(claim);
    mocks.request.mockImplementation((_options, callback) => callback(down));
    mocks.mutate.mockRejectedValue(down);

    await expect(replayStore(ID).claim(claim)).rejects.toBe(down);
    await expect(store.write(done)).rejects.toBe(down);
    await expect(store.release()).rejects.toBe(down);
  });
});
