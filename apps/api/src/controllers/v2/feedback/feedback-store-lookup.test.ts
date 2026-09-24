import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFeedbackJob: vi.fn(),
  select: vi.fn(),
  limit: vi.fn(),
}));

const query = {
  from: vi.fn(() => query),
  where: vi.fn(() => query),
  limit: mocks.limit,
};

vi.mock("../../../db/connection", () => ({
  db: { select: mocks.select },
  dbRr: {
    select: (...args: unknown[]) => {
      mocks.select(...args);
      return query;
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
    expect(mocks.select).not.toHaveBeenCalled();
    expect(job?.num_results_by_source).toBeUndefined();
  });

  it("reads the search columns when the caller sent positions", async () => {
    mocks.limit.mockResolvedValue([
      {
        options: { limit: 5, sources: [{ type: "web" }, { type: "news" }] },
        num_results: 8,
        num_results_by_source: { web: 5, images: 0, news: 3 },
        result_categories: { web: { "1": "developer" } },
      },
    ]);

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    expect(mocks.select).toHaveBeenCalledTimes(1);
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
    mocks.limit.mockResolvedValue([]);

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    expect(job).toBeTruthy();
    expect(job?.num_results_by_source).toBeUndefined();
    expect(job?.credits_cost).toBe(2);
  });

  it("keeps the labels when the supplementary read fails", async () => {
    mocks.limit.mockRejectedValue(new Error("read replica unavailable"));

    const job = await lookupFeedbackJob("search", jobId, teamId, true);

    expect(job).toBeTruthy();
    expect(job?.credits_cost).toBe(2);
  });

  it("does not read search columns for a non-search endpoint", async () => {
    mocks.readFeedbackJob.mockResolvedValue({
      ...bigtableJob,
      refundClass: "scrape_basic" as const,
    });

    const job = await lookupFeedbackJob("scrape", jobId, teamId, true);

    expect(job).toBeTruthy();
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
