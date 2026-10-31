import { vi } from "vitest";
import type { LoggedScrape } from "../services/logging/log_job";

const { save, remove, enqueueZdrCleanupJob, spans } = vi.hoisted(() => {
  const spans: Array<{ name: string; attributes: Record<string, unknown> }> =
    [];
  return {
    save: vi.fn(async () => {}),
    remove: vi.fn(async (): Promise<[unknown]> => [{ statusCode: 204 }]),
    enqueueZdrCleanupJob: vi.fn(async () => {}),
    spans,
  };
});

vi.mock("@google-cloud/storage", () => ({
  ApiError: class extends Error {
    code?: number;
  },
  Storage: class {
    bucket() {
      return { file: () => ({ save, delete: remove }) };
    }
  },
}));
vi.mock("../config", () => ({
  config: { GCS_BUCKET_NAME: "bucket", USE_DB_AUTHENTICATION: true },
}));
vi.mock("./zdr-queue", () => ({ enqueueZdrCleanupJob }));
vi.mock("./otel-tracer", () => ({
  withSpan: async (name: string, fn: (span: any) => any) => {
    const span = { attributes: {} };
    spans.push({ name, attributes: span.attributes });
    return fn(span);
  },
  setSpanAttributes: (
    span: { attributes: Record<string, unknown> },
    attributes: object,
  ) => Object.assign(span.attributes, attributes),
}));
vi.mock("./logger", () => {
  const logger: any = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger };
});

import { removeJobFromGCS, saveScrapeToGCS } from "./gcs-jobs";

const scrapeId = "019e6f45-7778-727d-adf0-0abe9d5062b6";

function scrape(zeroDataRetention: boolean): LoggedScrape {
  return {
    id: scrapeId,
    request_id: "019e6f45-7778-727d-adf0-0abe9d5062b7",
    url: "https://example.com",
    is_successful: true,
    doc: { markdown: "content", metadata: {} },
    time_taken: 1,
    team_id: "team-id",
    options: {},
    credits_cost: 1,
    skipNuq: false,
    zeroDataRetention,
  } as unknown as LoggedScrape;
}

describe("GCS job blobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spans.length = 0;
  });

  it("schedules a ZDR blob's delete before writing it", async () => {
    await saveScrapeToGCS(scrape(true));

    expect(enqueueZdrCleanupJob).toHaveBeenCalledWith({ blobId: scrapeId });
    expect(save).toHaveBeenCalledOnce();
    expect(enqueueZdrCleanupJob.mock.invocationCallOrder[0]).toBeLessThan(
      save.mock.invocationCallOrder[0],
    );
  });

  it("does not schedule a delete for a non-ZDR blob", async () => {
    await saveScrapeToGCS(scrape(false));

    expect(enqueueZdrCleanupJob).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not write a ZDR blob when its delete could not be scheduled", async () => {
    enqueueZdrCleanupJob.mockRejectedValueOnce(
      new Error("RabbitMQ unavailable"),
    );

    await expect(saveScrapeToGCS(scrape(true))).rejects.toThrow(
      "RabbitMQ unavailable",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("records whether a removed blob still existed", async () => {
    await removeJobFromGCS("blob-found");
    remove.mockResolvedValueOnce([{ statusCode: 404 }]);
    await removeJobFromGCS("blob-missing");

    expect(remove).toHaveBeenCalledWith({ ignoreNotFound: true });
    expect(
      spans
        .filter(span => span.name === "firecrawl-gcs-remove-job")
        .map(span => span.attributes),
    ).toEqual([
      expect.objectContaining({
        "job.id": "blob-found",
        "gcs.delete_successful": true,
        "gcs.job_not_found": false,
      }),
      expect.objectContaining({
        "job.id": "blob-missing",
        "gcs.delete_successful": true,
        "gcs.job_not_found": true,
      }),
    ]);
  });
});
