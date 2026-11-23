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
const KEY = `alexandria:retrieve:${ID}`;
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

const redisRecord = () => JSON.parse(mocks.redis.get(KEY)!);
/** The row as the fake holds it: its newest cell, decoded, and when that cell expires. */
const stored = (id = ID) => {
  const cell = mocks.rows.get(id)?.get("s:v")?.[0];
  return {
    record: cell ? JSON.parse(cell.value.toString()) : undefined,
    expiresAt: cell ? cell.micros / 1000 : undefined,
  };
};
/** A record as a pod that keeps it in Bigtable alone writes it: not marked as a copy. */
const seedBigtableOnly = (record: Retrieval, now = Date.now()) =>
  mocks.put(ID, "s:v", {
    micros: (now + 7 * DAY) * 1000,
    value: Buffer.from(
      JSON.stringify({
        ...record,
        version: 1,
        expiresAt: now + 7 * DAY,
        owner: "another-request",
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
/** Copies are written behind the request; this waits for the ones in flight. */
const copied = async (check: () => void) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return check();
    } catch (error) {
      if (attempt === 200) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
};

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
  it("claims in Redis and copies the claim to Bigtable", async () => {
    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });

    expect(redisRecord()).toEqual(claim);
    expect(stored()).toMatchObject({
      record: { ...claim, version: 1, copy: true, expiresAt: START + 7 * DAY },
      expiresAt: START + 7 * DAY,
    });
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

  it("copies each later write, and Redis still answers a repeat", async () => {
    const store = replayStore(ID);
    await store.claim(claim);
    await store.write(done);

    await copied(() => expect(stored().record.phase).toBe("done"));
    expect(stored().record).toMatchObject({
      ...done,
      copy: true,
      expiresAt: START + 7 * DAY,
    });
    expect(await replayStore(ID).claim(claim)).toEqual({
      claimed: false,
      existing: done,
    });
  });

  it("never copies a response a record still carries", async () => {
    const store = replayStore(ID);
    await store.claim(claim);
    await store.write({ ...done, response: { status: 200, body: "kept" } });

    await copied(() => expect(stored().record.phase).toBe("done"));
    expect(stored().record).not.toHaveProperty("response");
  });

  it("drops the record from both on release", async () => {
    const store = replayStore(ID);
    await store.claim(claim);
    expect(mocks.rows.size).toBe(1);
    await store.release();
    expect(mocks.redis.size).toBe(0);
    await copied(() => expect(mocks.rows.size).toBe(0));
  });

  it("does not trust a copy once Redis has lost the record, and takes the copy over", async () => {
    const first = replayStore(ID);
    await first.claim(claim);
    await first.write(done);
    await copied(() => expect(stored().record.phase).toBe("done"));
    const firstOwner = stored().record.owner;
    mocks.redis.clear();

    const again = { ...claim, scrapeId: "scrape-2" };
    expect(await replayStore(ID).claim(again)).toEqual({ claimed: true });
    expect(stored().record).toMatchObject({
      phase: "executing",
      scrapeId: "scrape-2",
      copy: true,
    });
    expect(stored().record.owner).not.toBe(firstOwner);
  });

  it("yields to a record kept in Bigtable alone and gives its Redis claim back", async () => {
    seedBigtableOnly(done);

    expect(await replayStore(ID).claim(claim)).toEqual({
      claimed: false,
      existing: done,
    });
    expect(mocks.redis.size).toBe(0);
    expect(stored().record.owner).toBe("another-request");
  });

  it("claims over a record that has expired but not been collected yet", async () => {
    seedBigtableOnly(done);
    vi.setSystemTime(START + 7 * DAY + 1);

    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });
    expect(stored().record).toMatchObject({ phase: "executing", copy: true });
    expect(stored().record.owner).not.toBe("another-request");
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
    // Its own record, so nothing to yield to and nothing to take over.
    expect(mocks.redis.size).toBe(1);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("takes back a copied claim whose answer never arrived", async () => {
    const apply = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementationOnce((options, callback) =>
      apply(options, () =>
        callback(Object.assign(new Error("unavailable"), { code: 7 })),
      ),
    );

    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });
    await copied(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(mocks.rows.size).toBe(0);
    expect(redisRecord()).toEqual(claim);
  });

  it("leaves another request's record alone when its own claim fails", async () => {
    seedBigtableOnly(done);
    mocks.getRows.mockRejectedValue(
      Object.assign(new Error("unavailable"), { code: 7 }),
    );

    expect(await replayStore(ID).claim(claim)).toEqual({ claimed: true });
    await copied(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(stored().record.owner).toBe("another-request");
  });

  it("never fails a request because Bigtable did", async () => {
    const down = Object.assign(new Error("unavailable"), { code: 7 });
    mocks.request.mockImplementation((_options, callback) => callback(down));
    mocks.mutate.mockRejectedValue(down);
    mocks.getRows.mockRejectedValue(down);

    const store = replayStore(ID);
    expect(await store.claim(claim)).toEqual({ claimed: true });
    await store.write(done);
    expect(await replayStore(ID).claim(claim)).toEqual({
      claimed: false,
      existing: done,
    });
    await store.release();
    expect(mocks.redis.size).toBe(0);
  });

  it("leaves a row alone when its own claim never reached it", async () => {
    seedBigtableOnly(done);
    const down = Object.assign(new Error("unavailable"), { code: 7 });
    mocks.request.mockImplementation((_options, callback) => callback(down));

    const store = replayStore(ID);
    expect(await store.claim(claim)).toEqual({ claimed: true });
    await store.write({ ...claim, lockId: "held" });
    await store.release();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(stored().record).toMatchObject({
      phase: "done",
      owner: "another-request",
    });
  });

  it("waits half a second at most for the claim's copy, and for no other copy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    mocks.request.mockImplementation(() => {});
    const store = replayStore(ID);

    let claimed: unknown;
    const claiming = store.claim(claim).then(result => {
      claimed = result;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(claimed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await claiming;
    expect(claimed).toEqual({ claimed: true });

    // The claim's copy never finished, so the copies behind it never start.
    await store.write(done);
    await store.release();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.redis.size).toBe(0);
  });

  it("writes copies in the order the request made them", async () => {
    const order: string[] = [];
    const apply = mocks.mutate.getMockImplementation()!;
    mocks.mutate.mockImplementation(async entries => {
      // The first copy is the slowest, so a later one would overtake it if it could.
      await new Promise(resolve => setTimeout(resolve, order.length ? 0 : 20));
      order.push(entries[0].method);
      return apply(entries);
    });
    const store = replayStore(ID);
    await store.claim(claim);
    await store.write({ ...claim, lockId: "held" });
    await store.release();

    await copied(() => expect(order).toEqual(["insert", "delete"]));
    expect(mocks.rows.size).toBe(0);
  });
});
