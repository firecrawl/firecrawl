import { vi } from "vitest";

const { save, enqueueZdrCleanupJob } = vi.hoisted(() => ({
  save: vi.fn(async () => {}),
  enqueueZdrCleanupJob: vi.fn(async (_jobId: string) => {}),
}));

vi.mock("@google-cloud/storage", () => {
  class Storage {
    bucket() {
      return { file: () => ({ save }) };
    }
  }
  class ApiError extends Error {
    code?: number;
  }
  return { Storage, ApiError };
});
vi.mock("./zdr-queue", () => ({ enqueueZdrCleanupJob }));
vi.mock("../config", () => ({
  config: { GCS_BUCKET_NAME: "results", USE_DB_AUTHENTICATION: true },
}));
vi.mock("./logger", () => {
  const logger: any = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger };
});
vi.mock("./otel-tracer", () => ({
  withSpan: vi.fn(async (_name: string, fn: (span: any) => any) => fn({})),
  setSpanAttributes: vi.fn(),
}));

import { saveScrapeToGCS } from "./gcs-jobs";

function scrape(zeroDataRetention: boolean) {
  return {
    id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    request_id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    team_id: "team-id",
    is_successful: true,
    doc: { markdown: "content" },
    zeroDataRetention,
    time_taken: 1,
    url: "https://example.com",
    options: {},
  } as any;
}

describe("saveScrapeToGCS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues a ZDR result's cleanup before writing it", async () => {
    await saveScrapeToGCS(scrape(true));

    expect(enqueueZdrCleanupJob).toHaveBeenCalledWith(
      "019e6f45-7778-727d-adf0-0abe9d5062b6",
    );
    expect(save).toHaveBeenCalledOnce();
    expect(enqueueZdrCleanupJob.mock.invocationCallOrder[0]).toBeLessThan(
      save.mock.invocationCallOrder[0],
    );
  });

  it("does not write a ZDR result unless its cleanup job was confirmed", async () => {
    enqueueZdrCleanupJob.mockRejectedValueOnce(
      new Error("RabbitMQ unavailable"),
    );

    await expect(saveScrapeToGCS(scrape(true))).rejects.toThrow(
      "RabbitMQ unavailable",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("writes a non-ZDR result without queueing cleanup", async () => {
    await saveScrapeToGCS(scrape(false));

    expect(enqueueZdrCleanupJob).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });
});
