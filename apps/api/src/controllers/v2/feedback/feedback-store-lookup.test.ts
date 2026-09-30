import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFeedbackJob: vi.fn(),
  replicaSelect: vi.fn(),
  replicaLimit: vi.fn(),
  primarySelect: vi.fn(),
  primaryLimit: vi.fn(),
}));

const replicaQuery = {
  from: vi.fn(() => replicaQuery),
  where: vi.fn(() => replicaQuery),
  limit: mocks.replicaLimit,
};

const primaryQuery = {
  from: vi.fn(() => primaryQuery),
  where: vi.fn(() => primaryQuery),
  limit: mocks.primaryLimit,
};

vi.mock("../../../db/connection", () => ({
  db: {
    select: (...args: unknown[]) => {
      mocks.primarySelect(...args);
      return primaryQuery;
    },
  },
  dbRr: {
    select: (...args: unknown[]) => {
      mocks.replicaSelect(...args);
      return replicaQuery;
    },
  },
}));

vi.mock("../../../lib/feedback-job-store", () => ({
  readFeedbackJob: mocks.readFeedbackJob,
}));

vi.mock("../../../lib/job-store-fallback", () => ({
  recordJobStorePostgresFallback: vi.fn(),
}));

import { lookupFeedbackJob } from "./feedback-store";

const jobId = "01933161-0000-7000-8000-000000000001";
const teamId = "01933161-0000-7000-8000-000000000002";

// A Bigtable feedback record: everything the refund and window checks need,
// and nothing about the results themselves.
const bigtableJob = {
  requestId: "01933161-0000-7000-8000-00000000000a",
  teamId,
  refundClass: "search" as const,
  feedbackDeadlineMs: Date.now() + 60_000,
  succeeded: true,
  creditsBilled: 2,
  zeroDataRetention: false,
};

describe("lookupFeedbackJob on the Bigtable fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFeedbackJob.mockResolvedValue(bigtableJob);
  });

  it("serves a rating-only submission without touching PostgreSQL", async () => {
    const job = await lookupFeedbackJob("search", jobId, teamId);

    expect(job).toBeTruthy();
    // The fast path is the whole point: no supplementary read when the caller
    // sent no positions to bound.
    expect(mocks.replicaSelect).not.toHaveBeenCalled();
    expect(mocks.primarySelect).not.toHaveBeenCalled();
    expect(job?.num_results_by_source).toBeUndefined();
  });

  it("reads the search columns when the caller sent positions", async () => {
    mocks.replicaLimit.mockResolvedValue([
      {
        options: { limit: 5, sources: [{ type: "web" }, { type: "news" }] },
        num_results: 8,
        num_results_by_source: { web: 5, images: 0, news: 3 },
        result_categories: { web: { "1": "developer" } },
      },
    ]);

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    expect(mocks.replicaSelect).toHaveBeenCalledTimes(1);
    expect(mocks.primarySelect).not.toHaveBeenCalled();
    expect(job?.num_results).toBe(8);
    expect(job?.num_results_by_source).toEqual({ web: 5, images: 0, news: 3 });
    expect(job?.result_categories).toEqual({ web: { "1": "developer" } });
    expect(job?.options).toEqual({
      limit: 5,
      sources: [{ type: "web" }, { type: "news" }],
    });
    // The Bigtable-supplied fields survive the merge.
    expect(job?.credits_cost).toBe(2);
    expect(job?.zero_data_retention).toBe(false);
  });

  it("keeps the labels when the searches row is not there yet", async () => {
    // logSearch writes the Bigtable record before the `searches` row, so a
    // fast caller can arrive in between. Unknown bound, not dropped feedback.
    mocks.replicaLimit.mockResolvedValue([]);

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    expect(job).toBeTruthy();
    expect(job?.num_results_by_source).toBeUndefined();
    expect(job?.credits_cost).toBe(2);
  });

  it("falls back to the primary when the replica read fails", async () => {
    mocks.replicaLimit.mockRejectedValue(new Error("read replica unavailable"));
    mocks.primaryLimit.mockResolvedValue([
      {
        options: { limit: 5 },
        num_results: 4,
        num_results_by_source: { web: 4, images: 0, news: 0 },
        result_categories: null,
      },
    ]);

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    // A replica error says nothing about whether the row exists, so the bounds
    // are recovered rather than given up.
    expect(mocks.primarySelect).toHaveBeenCalledTimes(1);
    expect(job?.num_results_by_source).toEqual({ web: 4, images: 0, news: 0 });
  });

  it("keeps the labels when both connections fail", async () => {
    mocks.replicaLimit.mockRejectedValue(new Error("read replica unavailable"));
    mocks.primaryLimit.mockRejectedValue(new Error("primary unavailable"));

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    expect(job).toBeTruthy();
    expect(job?.num_results_by_source).toBeUndefined();
    expect(job?.credits_cost).toBe(2);
  });

  it("does not read search columns for a non-search endpoint", async () => {
    mocks.readFeedbackJob.mockResolvedValue({
      ...bigtableJob,
      refundClass: "scrape_basic" as const,
    });

    const job = await lookupFeedbackJob("scrape", jobId, teamId, true);

    expect(job).toBeTruthy();
    expect(mocks.replicaSelect).not.toHaveBeenCalled();
  });

  it("does not read search columns for a zero-data-retention job", async () => {
    mocks.readFeedbackJob.mockResolvedValue({
      ...bigtableJob,
      zeroDataRetention: true,
    });

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    // Its feedback is dropped before the bounds are consulted, and both
    // columns are redacted for it, so there is nothing to fetch.
    expect(job?.zero_data_retention).toBe(true);
    expect(mocks.replicaSelect).not.toHaveBeenCalled();
    expect(mocks.primarySelect).not.toHaveBeenCalled();
  });
});
