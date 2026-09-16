import { vi } from "vitest";

const {
  tables,
  select,
  update,
  set,
  where,
  getZdrCleanupBatch,
  removeJobFromGCS,
  spans,
  withSpan,
  setSpanAttributes,
} = vi.hoisted(() => {
  const makeTable = (name: string) => ({
    name,
    id: `${name}.id`,
    request_id: `${name}.request_id`,
  });
  const tables = {
    requests: makeTable("requests"),
    scrapes: makeTable("scrapes"),
    searches: makeTable("searches"),
    extracts: makeTable("extracts"),
    maps: makeTable("maps"),
    llmstxts: makeTable("llmstxts"),
    deep_researches: makeTable("deep_researches"),
  };
  const where = vi.fn(async () => {});
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const select = vi.fn(() => ({
    from: (table: { name: string }) => ({
      where: vi.fn(async () => [{ id: `${table.name}-blob` }]),
    }),
  }));
  const spans: Array<{ name: string; attributes: Record<string, unknown> }> =
    [];
  const withSpan = vi.fn(async (name: string, fn: (span: any) => any) => {
    const span = { attributes: {} };
    spans.push({ name, attributes: span.attributes });
    return fn(span);
  });
  const setSpanAttributes = vi.fn(
    (span: { attributes: Record<string, unknown> }, attributes: object) => {
      Object.assign(span.attributes, attributes);
    },
  );
  return {
    tables,
    select,
    update,
    set,
    where,
    getZdrCleanupBatch: vi.fn<
      (limit: number) => Promise<Array<{ request_id: string; ids: string[] }>>
    >(async () => []),
    removeJobFromGCS: vi.fn<(id: string) => Promise<void>>(async () => {}),
    spans,
    withSpan,
    setSpanAttributes,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => "eq"),
  inArray: vi.fn(() => "inArray"),
}));
vi.mock("../db/connection", () => ({ db: { select, update } }));
vi.mock("../db/schema", () => tables);
vi.mock("../db/rpc", () => ({ getZdrCleanupBatch }));
vi.mock("./gcs-jobs", () => ({ removeJobFromGCS }));
vi.mock("../config", () => ({ config: {} }));
vi.mock("./logger", () => {
  const logger: any = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger };
});
vi.mock("./otel-tracer", () => ({ withSpan, setSpanAttributes }));

import { cleanZdrRequest, zdrcleaner } from "./zdrcleaner";

describe("ZDR cleaner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getZdrCleanupBatch.mockResolvedValue([]);
    removeJobFromGCS.mockResolvedValue(undefined);
    spans.length = 0;
  });

  it("loads and removes every blob type for a queued request", async () => {
    await cleanZdrRequest("request-1");

    expect(select).toHaveBeenCalledTimes(6);
    expect(removeJobFromGCS.mock.calls.map(([id]) => id)).toEqual([
      "scrapes-blob",
      "searches-blob",
      "extracts-blob",
      "maps-blob",
      "llmstxts-blob",
      "deep_researches-blob",
    ]);
    expect(spans).toEqual(
      expect.arrayContaining([
        {
          name: "zdr.cleanup.request",
          attributes: expect.objectContaining({
            "zdr.request_id": "request-1",
            "zdr.blob_count": 6,
            "zdr.cleanup.outcome": "completed",
          }),
        },
        {
          name: "zdr.postgres.read_blobs",
          attributes: expect.objectContaining({
            "db.system": "postgresql",
            "db.operation.name": "select",
            "db.response.returned_rows": 6,
          }),
        },
      ]),
    );
  });

  it("fails a queued request if any blob could not be removed", async () => {
    removeJobFromGCS.mockRejectedValueOnce(new Error("GCS unavailable"));

    await expect(cleanZdrRequest("request-2")).rejects.toThrow(
      "Failed to remove 1 blobs for ZDR request request-2",
    );
  });

  it("keeps draining and clearing legacy PostgreSQL schedules", async () => {
    getZdrCleanupBatch.mockResolvedValueOnce([
      { request_id: "legacy-1", ids: ["blob-1"] },
      { request_id: "legacy-2", ids: ["blob-2"] },
    ]);
    removeJobFromGCS.mockImplementation(async id => {
      if (id === "blob-2") throw new Error("GCS unavailable");
    });

    await zdrcleaner();

    expect(set).toHaveBeenCalledWith({ dr_clean_by: null });
    expect(where).toHaveBeenCalledOnce();
  });
});
