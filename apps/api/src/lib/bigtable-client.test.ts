import { vi } from "vitest";

const { withSpan, table, Bigtable, mutableConfig } = vi.hoisted(() => {
  const table = vi.fn((tableId: string) => ({ id: tableId }));
  return {
    withSpan: vi.fn(
      async (_name: string, fn: (span: any) => any) => await fn({}),
    ),
    table,
    Bigtable: vi.fn(function () {
      return { instance: () => ({ table }) };
    }),
    mutableConfig: {
      BIGTABLE_INSTANCE_ID: "instance",
      BIGTABLE_PROJECT_ID: "project",
    } as { BIGTABLE_INSTANCE_ID?: string; BIGTABLE_PROJECT_ID?: string },
  };
});

vi.mock("../config", () => ({ config: mutableConfig }));
vi.mock("@google-cloud/bigtable", () => ({ Bigtable }));
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes: vi.fn(),
}));

describe("getBigtableTable", () => {
  let getBigtableTable: typeof import("./bigtable-client").getBigtableTable;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mutableConfig.BIGTABLE_INSTANCE_ID = "instance";
    ({ getBigtableTable } = await import("./bigtable-client.js"));
  });

  it("records a span only the first time a table is resolved", async () => {
    const first = await getBigtableTable("scrape-state");
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("bigtable.table.resolve");

    const second = await getBigtableTable("scrape-state");
    expect(second).toBe(first);
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(table).toHaveBeenCalledTimes(1);
  });

  it("shares one resolution between concurrent callers", async () => {
    const resolved = await Promise.all([
      getBigtableTable("scrape-state"),
      getBigtableTable("scrape-state"),
      getBigtableTable("scrape-state"),
    ]);

    expect(resolved[1]).toBe(resolved[0]);
    expect(resolved[2]).toBe(resolved[0]);
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(table).toHaveBeenCalledTimes(1);
  });

  it("resolves each table once and shares the client", async () => {
    await getBigtableTable("scrape-state");
    const other = await getBigtableTable("job-access");

    expect(other).toEqual({ id: "job-access" });
    expect(withSpan).toHaveBeenCalledTimes(2);
    expect(Bigtable).toHaveBeenCalledTimes(1);
  });

  it("does not cache a resolution that threw", async () => {
    mutableConfig.BIGTABLE_INSTANCE_ID = undefined;
    await expect(getBigtableTable("scrape-state")).rejects.toThrow(
      "BIGTABLE_INSTANCE_ID is not configured",
    );

    mutableConfig.BIGTABLE_INSTANCE_ID = "instance";
    await expect(getBigtableTable("scrape-state")).resolves.toEqual({
      id: "scrape-state",
    });
    expect(withSpan).toHaveBeenCalledTimes(2);
  });
});
