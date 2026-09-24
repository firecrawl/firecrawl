import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, client } = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    client: { current: { query } as { query: typeof query } | null },
  };
});
vi.mock("./clickhouse-client", () => ({
  get clickhouseClient() {
    return client.current;
  },
}));
vi.mock("./otel-tracer", () => ({
  withSpan: vi.fn(async (_name: string, fn: (span: object) => unknown) =>
    fn({}),
  ),
  setSpanAttributes: vi.fn(),
}));

import { readRequestCreditsFromAnalytics } from "./request-credits-analytics";

function rows(list: Record<string, unknown>[]) {
  query.mockResolvedValueOnce({ json: vi.fn(async () => list) });
}

describe("readRequestCreditsFromAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.current = { query };
  });

  it("sums the request's scrape rows", async () => {
    rows([{ credits: "17", jobs: "4" }]);
    await expect(readRequestCreditsFromAnalytics("request-1")).resolves.toBe(
      17,
    );
    expect(query.mock.calls[0][0]).toMatchObject({
      query: expect.stringContaining(
        "FROM scrapes_by_request FINAL WHERE request_id = {requestId: UUID}",
      ),
      query_params: { requestId: "request-1" },
    });
  });

  it("is null when the request has no scrape rows", async () => {
    rows([{ credits: 0, jobs: 0 }]);
    await expect(
      readRequestCreditsFromAnalytics("request-1"),
    ).resolves.toBeNull();
  });

  it("is null when ClickHouse is not configured", async () => {
    client.current = null;
    await expect(
      readRequestCreditsFromAnalytics("request-1"),
    ).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates ClickHouse errors", async () => {
    query.mockRejectedValueOnce(new Error("ClickHouse unavailable"));
    await expect(readRequestCreditsFromAnalytics("request-1")).rejects.toThrow(
      "ClickHouse unavailable",
    );
  });
});
