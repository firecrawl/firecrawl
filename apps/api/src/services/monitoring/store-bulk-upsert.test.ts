// The db client is mocked so the abort/empty guards can assert no query is issued.
// bulkUpsertMonitorPages' actual SQL behavior (the ON CONFLICT field rules) is
// covered by the Docker integration test against a real Postgres — a mock can't
// exercise the enum / CASE semantics, which is exactly where the prior bugs hid.
const { dbInsert } = vi.hoisted(() => ({ dbInsert: vi.fn() }));

vi.mock("../../db/connection", () => ({
  db: { insert: dbInsert },
  dbRr: { select: vi.fn() },
  dbIndex: { select: vi.fn() },
}));

import { bulkUpsertMonitorPages } from "./store";

const hash = (hex: string) => Buffer.from(hex, "hex");

beforeEach(() => {
  dbInsert.mockReset();
});

describe("bulkUpsertMonitorPages guards", () => {
  it("writes nothing when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      bulkUpsertMonitorPages({
        monitorId: "m1",
        teamId: "t1",
        targetId: "tg1",
        checkId: "c1",
        rows: [
          {
            url: "https://example.com/a",
            urlHash: hash("aa"),
            status: "new",
            metadata: {},
            source: "discovered",
            scrapeId: null,
          },
        ],
        abortSignal: controller.signal,
      }),
    ).resolves.toBeUndefined();

    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("writes nothing when there are no rows", async () => {
    await expect(
      bulkUpsertMonitorPages({
        monitorId: "m1",
        teamId: "t1",
        targetId: "tg1",
        checkId: "c1",
        rows: [],
      }),
    ).resolves.toBeUndefined();

    expect(dbInsert).not.toHaveBeenCalled();
  });
});
