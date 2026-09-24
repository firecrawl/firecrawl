import { vi } from "vitest";

const { query, spans, withSpan, setSpanAttributes, removeJobFromGCS, client } =
  vi.hoisted(() => {
    const query = vi.fn();
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
      query,
      spans,
      withSpan,
      setSpanAttributes,
      removeJobFromGCS: vi.fn<(id: string) => Promise<void>>(async () => {}),
      client: { current: { query } as { query: typeof query } | null },
    };
  });

vi.mock("./clickhouse-client", () => ({
  get clickhouseClient() {
    return client.current;
  },
}));
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

import { cleanZdrRequest } from "./zdrcleaner";
import { logger } from "./logger";

function mockChildren(ids: string[]) {
  query.mockResolvedValueOnce({
    json: vi.fn(async () => ids.map(id => ({ id }))),
  });
}

describe("ZDR cleaner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.current = { query };
    removeJobFromGCS.mockResolvedValue(undefined);
    spans.length = 0;
  });

  it("removes every indexed blob for a queued request", async () => {
    mockChildren(["scrape-blob", "search-blob", "map-blob"]);

    await cleanZdrRequest("request-1");

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toMatchObject({
      query:
        "SELECT DISTINCT id FROM request_children WHERE request_id = {requestId: UUID}",
      query_params: { requestId: "request-1" },
      format: "JSONEachRow",
    });
    expect(removeJobFromGCS.mock.calls.map(([id]) => id)).toEqual([
      "scrape-blob",
      "search-blob",
      "map-blob",
    ]);
    expect(spans).toEqual(
      expect.arrayContaining([
        {
          name: "zdr.cleanup.request",
          attributes: expect.objectContaining({
            "zdr.request_id": "request-1",
            "zdr.blob_count": 3,
            "zdr.cleanup.outcome": "completed",
          }),
        },
        {
          name: "zdr.clickhouse.read_blobs",
          attributes: expect.objectContaining({
            "db.system": "clickhouse",
            "db.collection.name": "request_children",
            "db.response.returned_rows": 3,
          }),
        },
      ]),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("completes quietly when a request has no indexed blobs", async () => {
    mockChildren([]);

    await cleanZdrRequest("request-empty");

    expect(removeJobFromGCS).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "ZDR request has no indexed result blobs",
      expect.objectContaining({ requestId: "request-empty" }),
    );
  });

  it("fails a queued request if any blob could not be removed", async () => {
    mockChildren(["blob-1", "blob-2"]);
    removeJobFromGCS.mockImplementation(async id => {
      if (id === "blob-2") throw new Error("GCS unavailable");
    });

    await expect(cleanZdrRequest("request-2")).rejects.toThrow(
      "Failed to remove 1 blobs for ZDR request request-2",
    );
  });

  it("fails a queued request when ClickHouse is not configured", async () => {
    client.current = null;

    await expect(cleanZdrRequest("request-3")).rejects.toThrow(
      "ClickHouse is not configured",
    );
    expect(removeJobFromGCS).not.toHaveBeenCalled();
  });

  it("propagates ClickHouse read failures so the job is retried", async () => {
    query.mockRejectedValueOnce(new Error("ClickHouse unavailable"));

    await expect(cleanZdrRequest("request-4")).rejects.toThrow(
      "ClickHouse unavailable",
    );
    expect(removeJobFromGCS).not.toHaveBeenCalled();
  });
});
