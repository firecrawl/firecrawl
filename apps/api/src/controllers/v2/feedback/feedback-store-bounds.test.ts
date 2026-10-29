import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackJobRow, FeedbackRecordOptions } from "./internal-types";

const mocks = vi.hoisted(() => ({
  values: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../db/connection", () => ({
  db: { insert: () => ({ values: mocks.values }) },
  dbRr: { select: () => ({}) },
}));

vi.mock("../../../lib/feedback-job-store", () => ({
  readFeedbackJob: vi.fn(),
}));

import { insertFeedback } from "./feedback-store";

const searchId = "01933161-0000-7000-8000-000000000001";
const teamId = "01933161-0000-7000-8000-000000000002";

function searchJob(overrides: Partial<FeedbackJobRow> = {}): FeedbackJobRow {
  return {
    endpoint: "search",
    id: searchId,
    request_id: null,
    team_id: teamId,
    credits_cost: 2,
    created_at: new Date().toISOString(),
    is_successful: true,
    // The Bigtable feedback job carries no request body.
    options: null,
    ...overrides,
  };
}

function options(
  valuableResults: { source: string; position: number }[],
): FeedbackRecordOptions {
  return {
    endpoint: "search",
    jobId: searchId,
    feedback: { rating: "good", valuableResults } as any,
    source: "search_feedback",
  } as FeedbackRecordOptions;
}

async function recordedPositions(
  job: FeedbackJobRow,
  valuableResults: { source: string; position: number }[],
) {
  mocks.values.mockClear();
  await insertFeedback({
    feedbackId: "01933161-0000-7000-8000-00000000000f",
    options: options(valuableResults),
    job,
    dbTeamId: teamId,
  });
  const row = mocks.values.mock.calls[0]?.[0];
  return (row?.metadata as { valuableResults?: unknown[] })?.valuableResults;
}

describe("position bounds from the feedback job's per-source counts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bounds each group by its own count", async () => {
    const job = searchJob({
      num_results_by_source: { web: 5, images: 0, news: 3 },
    });

    expect(
      await recordedPositions(job, [
        { source: "web", position: 5 },
        // Past the web group, even though other groups have room.
        { source: "web", position: 6 },
        { source: "news", position: 3 },
        // images returned nothing, so no position in it is real.
        { source: "images", position: 1 },
      ]),
    ).toEqual([
      { source: "web", position: 5 },
      { source: "news", position: 3 },
    ]);
  });

  it("rejects every position for a group the counts omit", async () => {
    // A group absent from the counts returned nothing — there is no looser
    // bound to fall back to now that the counts are exact.
    const job = searchJob({ num_results_by_source: { web: 2 } });

    expect(
      await recordedPositions(job, [
        { source: "web", position: 1 },
        { source: "news", position: 1 },
      ]),
    ).toEqual([{ source: "web", position: 1 }]);
  });

  it("treats an empty count map as a search that returned nothing", async () => {
    const job = searchJob({ num_results_by_source: {} });

    expect(
      await recordedPositions(job, [{ source: "web", position: 1 }]),
    ).toBeUndefined();
  });

  it("leaves positions unbounded when the job predates the counts", async () => {
    // Absent is not empty. Feedback is only accepted within
    // SEARCH_FEEDBACK_MAX_AGE_SEC of the search, so this covers the couple of
    // minutes spanning the deploy and then closes on its own.
    const job = searchJob({ num_results_by_source: null });

    expect(
      await recordedPositions(job, [{ source: "news", position: 2 }]),
    ).toEqual([{ source: "news", position: 2 }]);
  });

  it("attributes the serving vertical when the job carries it", async () => {
    const job = searchJob({
      num_results_by_source: { web: 3, images: 0, news: 0 },
      result_categories: { web: { "1": "developer" } },
    });

    expect(
      await recordedPositions(job, [
        { source: "web", position: 1 },
        { source: "web", position: 2 },
      ]),
    ).toEqual([
      { source: "web", position: 1, category: "developer" },
      { source: "web", position: 2 },
    ]);
  });

  it("drops duplicate and non-positive positions", async () => {
    const job = searchJob({ num_results_by_source: { web: 3 } });

    expect(
      await recordedPositions(job, [
        { source: "web", position: 1 },
        { source: "web", position: 1 },
        { source: "web", position: 0 },
      ]),
    ).toEqual([{ source: "web", position: 1 }]);
  });
});
