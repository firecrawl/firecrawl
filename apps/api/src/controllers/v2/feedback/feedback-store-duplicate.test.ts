import { describe, expect, it, vi } from "vitest";
import type { FeedbackJobRow, FeedbackRecordOptions } from "./internal-types";

// A real Drizzle client over a pg client that refuses every query the way
// PostgreSQL refuses a second row for a unique index, so the error reaches the
// store wrapped exactly as it is in production.
vi.mock("../../../db/connection", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const uniqueViolation = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "search_feedback_once_per_job_idx"',
    ),
    { code: "23505" },
  );
  const db = drizzle({
    client: { query: async () => Promise.reject(uniqueViolation) } as any,
  });
  return { db, dbRr: db };
});
vi.mock("../../../lib/feedback-job-store", () => ({
  readFeedbackJob: vi.fn(),
}));

import { insertFeedback } from "./feedback-store";

const jobId = "01933161-0000-7000-8000-000000000001";

const job: FeedbackJobRow = {
  endpoint: "search",
  id: jobId,
  request_id: null,
  team_id: "01933161-0000-7000-8000-000000000002",
  credits_cost: 2,
  created_at: new Date().toISOString(),
  is_successful: true,
  options: null,
};

const options = {
  endpoint: "search",
  jobId,
  feedback: {
    rating: "good",
    valuableSources: [{ url: "https://example.com/" }],
  },
  source: "search_feedback",
} as FeedbackRecordOptions;

describe("insertFeedback on a second submission for the same job", () => {
  it("returns the PostgreSQL unique-violation code the duplicate path checks", async () => {
    const error = await insertFeedback({
      feedbackId: "01933161-0000-7000-8000-00000000000f",
      options,
      job,
      dbTeamId: job.team_id,
    });
    expect(error?.code).toBe("23505");
  });
});
