import { beforeEach, describe, expect, it, vi } from "vitest";
import { scrapePDFWithRunPodMU } from "../runpodMU";
import { getPdfResultFromCache } from "../../../../../lib/gcs-pdf-cache";
import { consumeRefresh } from "../fire-pdf/refresh-budget";

vi.mock("../../../../../lib/gcs-pdf-cache", () => ({
  getPdfResultFromCache: vi.fn(),
  savePdfResultToCache: vi.fn(),
  resolvePdfCacheKey: vi.fn(() => "key-of-BASE64"),
}));

vi.mock("../fire-pdf/refresh-budget", () => ({
  consumeRefresh: vi.fn(async () => "allowed"),
}));

const getCached = vi.mocked(getPdfResultFromCache);
const budget = vi.mocked(consumeRefresh);

const cached = { markdown: "cached", html: "<p>cached</p>" };

function makeMeta(parsers?: unknown[], zeroDataRetention = false) {
  return {
    id: "mu-cache-test",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() },
    internalOptions: { teamId: "team-1", zeroDataRetention },
    // Already aborted: the engine stops right after the cache step, before
    // any network call, which is all these tests exercise.
    abort: AbortSignal.abort(),
    ...(parsers ? { options: { parsers } } : {}),
  } as any;
}

describe("RunPod MU cache read and refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCached.mockResolvedValue(cached as any);
    budget.mockResolvedValue("allowed");
  });

  it("serves the cached result and leaves the refresh budget alone", async () => {
    const meta = makeMeta();
    await expect(
      scrapePDFWithRunPodMU(meta, "/tmp/doc.pdf", "BASE64"),
    ).resolves.toEqual(cached);
    expect(getCached).toHaveBeenCalledWith("BASE64");
    expect(budget).not.toHaveBeenCalled();
  });

  it("skips the cache read on refresh within the team budget", async () => {
    const meta = makeMeta([{ type: "pdf", refresh: true }]);
    await expect(
      scrapePDFWithRunPodMU(meta, "/tmp/doc.pdf", "BASE64"),
    ).rejects.toThrow();
    expect(budget).toHaveBeenCalledWith("team-1", "mu-cache-test");
    expect(getCached).not.toHaveBeenCalled();
    expect(meta.logger.info).toHaveBeenCalledWith(
      "RunPod MU cache bypassed by refresh",
      expect.objectContaining({
        tempFilePath: "/tmp/doc.pdf",
        cacheKey: "key-of-BASE64",
      }),
    );
  });

  it("serves the cached result when the refresh budget is spent", async () => {
    budget.mockResolvedValueOnce("limited");
    const meta = makeMeta([{ type: "pdf", refresh: true }]);
    await expect(
      scrapePDFWithRunPodMU(meta, "/tmp/doc.pdf", "BASE64"),
    ).resolves.toEqual(cached);
    expect(getCached).toHaveBeenCalledWith("BASE64");
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "RunPod MU cache refresh not applied",
      expect.objectContaining({
        decision: "limited",
        cacheKey: "key-of-BASE64",
      }),
    );
  });

  it("never reads the cache for a zero-data-retention request", async () => {
    const meta = makeMeta([{ type: "pdf", refresh: true }], true);
    await expect(
      scrapePDFWithRunPodMU(meta, "/tmp/doc.pdf", "BASE64"),
    ).rejects.toThrow();
    expect(getCached).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();
  });

  it("does not spend the budget when maxPages already skips the cache", async () => {
    const meta = makeMeta([{ type: "pdf", refresh: true }]);
    await expect(
      scrapePDFWithRunPodMU(meta, "/tmp/doc.pdf", "BASE64", 5),
    ).rejects.toThrow();
    expect(budget).not.toHaveBeenCalled();
    expect(getCached).not.toHaveBeenCalled();
  });
});
