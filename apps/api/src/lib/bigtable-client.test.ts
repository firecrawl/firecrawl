import { vi } from "vitest";

const { withSpan, table, Bigtable } = vi.hoisted(() => {
  const table = vi.fn((tableId: string) => ({ id: tableId }));
  return {
    withSpan: vi.fn(
      async (_name: string, fn: (span: any) => any) => await fn({}),
    ),
    table,
    Bigtable: vi.fn(function () {
      return { instance: () => ({ table }) };
    }),
  };
});

vi.mock("../config", () => ({
  config: { BIGTABLE_INSTANCE_ID: "instance", BIGTABLE_PROJECT_ID: "project" },
}));
vi.mock("@google-cloud/bigtable", () => ({ Bigtable }));
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes: vi.fn(),
}));

import { getBigtableTable } from "./bigtable-client";

describe("getBigtableTable", () => {
  it("records a span only the first time a table is resolved", async () => {
    const first = await getBigtableTable("scrape-state");
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("bigtable.table.resolve");

    const second = await getBigtableTable("scrape-state");
    expect(second).toBe(first);
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(table).toHaveBeenCalledTimes(1);
  });

  it("resolves each table once and shares the client", async () => {
    const other = await getBigtableTable("job-access");
    expect(other).toEqual({ id: "job-access" });
    expect(withSpan).toHaveBeenCalledTimes(2);
    expect(Bigtable).toHaveBeenCalledTimes(1);
  });
});
