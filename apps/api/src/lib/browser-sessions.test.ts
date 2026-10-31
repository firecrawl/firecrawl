import { PgDialect } from "drizzle-orm/pg-core";
import {
  abandonBrowserSession,
  settleBrowserSessionOnce,
} from "./browser-sessions";

// Exercise the actual helpers and Drizzle predicates through a controlled
// transaction boundary. This is not a live PostgreSQL row-lock claim.
const fixture = vi.hoisted(() => ({
  row: null as any,
  updates: [] as any[],
  predicates: [] as any[],
  lockModes: [] as string[],
  failWrite: false,
}));
vi.mock("../db/connection", () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: (predicate: any) => ({
          for: async (mode: string) => {
            fixture.predicates.push(predicate);
            fixture.lockModes.push(mode);
            return fixture.row ? [{ ...fixture.row }] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: any) => ({
        where: async (predicate: any) => {
          fixture.predicates.push(predicate);
          if (fixture.failWrite) throw new Error("transaction write failed");
          fixture.updates.push(values);
          fixture.row = { ...fixture.row, ...values };
        },
      }),
    }),
  };
  const db = { transaction: async (run: any) => run(tx) };
  return { db, dbRr: db, dbIndex: db, getDbPoolMetrics: () => "" };
});

describe("abandonBrowserSession transaction boundary", () => {
  beforeEach(() => {
    fixture.row = {
      id: "unexposed-session",
      status: "active",
      credits_used: null,
      should_bill: true,
      scrape_id: "scrape-123",
      zero_data_retention: true,
    };
    fixture.updates = [];
    fixture.predicates = [];
    fixture.lockModes = [];
    fixture.failWrite = false;
  });
  it("unlinks and disables billing before subsequent settlement without changing privacy", async () => {
    const abandoned = await abandonBrowserSession(fixture.row.id);
    expect(abandoned).toMatchObject({
      should_bill: false,
      scrape_id: null,
      zero_data_retention: true,
    });
    expect(fixture.row).toMatchObject(abandoned);
    expect(fixture.updates).toEqual([
      expect.objectContaining({ should_bill: false, scrape_id: null }),
    ]);
    expect(fixture.lockModes).toEqual(["update"]);
    const dialect = new PgDialect();
    for (const predicate of fixture.predicates)
      expect(dialect.sqlToQuery(predicate).params).toEqual([
        "unexposed-session",
      ]);
    const bill = vi.fn(async row => (row.should_bill ? 10 : 0));
    expect(await settleBrowserSessionOnce(abandoned.id, bill)).toEqual({
      creditsBilled: 0,
      newlySettled: true,
    });
    expect(bill).toHaveBeenCalledWith(
      expect.objectContaining({ should_bill: false, scrape_id: null }),
    );
    expect(fixture.row.credits_used).toBe(0);
  });
  it.each([{ status: "destroyed" }, { credits_used: 0 }])(
    "rejects already settled rows without a write: %j",
    async state => {
      Object.assign(fixture.row, state);
      await expect(abandonBrowserSession(fixture.row.id)).rejects.toThrow(
        "already settled",
      );
      expect(fixture.updates).toEqual([]);
    },
  );
  it("does not return a falsely abandoned row when the transaction write fails", async () => {
    fixture.failWrite = true;
    await expect(abandonBrowserSession(fixture.row.id)).rejects.toThrow(
      "transaction write failed",
    );
    expect(fixture.row).toMatchObject({
      should_bill: true,
      scrape_id: "scrape-123",
    });
  });
});
