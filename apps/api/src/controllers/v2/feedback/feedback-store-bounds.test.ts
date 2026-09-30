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

vi.mock("../../../lib/job-store-fallback", () => ({
  recordJobStorePostgresFallback: vi.fn(),
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

describe("position bounds by what the job row still holds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bounds each group by its own count when they are known", async () => {
    const job = searchJob({
      num_results: 8,
      num_results_by_source: { web: 5, images: 0, news: 3 },
      options: { limit: 5, sources: [{ type: "web" }, { type: "news" }] },
    });

    expect(
      await recordedPositions(job, [
        { source: "web", position: 5 },
        // Beyond the web group, even though the combined total leaves room.
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

  it("bounds a source the request never asked for to nothing", async () => {
    const job = searchJob({
      num_results: 6,
      num_results_by_source: null,
      options: { limit: 3, sources: [{ type: "web" }] },
    });

    expect(
      await recordedPositions(job, [
        { source: "web", position: 1 },
        { source: "news", position: 1 },
      ]),
    ).toEqual([{ source: "web", position: 1 }]);
  });

  // A zero-data-retention row keeps only `{enterprise}` — `sources` is
  // redacted, not absent because the caller omitted it. Reading it as the
  // ["web"] prefault would bound news to 0 and discard every news label, so
  // the row counts as unknown and falls back to min(limit, num_results).
  //
  // Unreachable through the API today: recordFeedback drops ZDR feedback
  // before it reaches these bounds. Kept, and tested here, because that guard
  // lives in another module — if its precedence changes, this is what stops
  // the labels being silently dropped.
  it("treats a redacted row as unknown rather than web-only", async () => {
    const job = searchJob({
      num_results: 6,
      num_results_by_source: null,
      result_categories: null,
      options: { enterprise: ["zdr"], limit: 3 },
    });

    expect(
      await recordedPositions(job, [
        { source: "news", position: 1 },
        // Still bounded by min(limit, num_results).
        { source: "news", position: 5 },
      ]),
    ).toEqual([{ source: "news", position: 1 }]);
  });

  it("treats a row with no persisted options as unknown", async () => {
    // What the Bigtable fast path hands over when the supplementary read
    // could not fill it in.
    const job = searchJob({ options: null });

    expect(
      await recordedPositions(job, [{ source: "news", position: 2 }]),
    ).toEqual([{ source: "news", position: 2 }]);
  });

  it("attributes the serving vertical when the row carries it", async () => {
    const job = searchJob({
      num_results: 3,
      num_results_by_source: { web: 3, images: 0, news: 0 },
      options: { limit: 3, sources: [{ type: "web" }] },
      result_categories: { web: { "1": "developer" } },
    });

    expect(
      await recordedPositions(job, [{ source: "web", position: 1 }]),
    ).toEqual([{ source: "web", position: 1, category: "developer" }]);
  });
});
