import { describeIf, TEST_PRODUCTION, TEST_SUITE_WEBSITE } from "../lib";
import {
  endpointFeedback,
  endpointFeedbackRaw,
  endpointFeedbackWithFailure,
  expectMapToSucceed,
  idmux,
  Identity,
  map,
  scrapeTimeout,
  searchRawFull,
} from "./lib";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";

let identity: Identity;
let secondaryIdentity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "endpoint-feedback",
    concurrency: 100,
    credits: 1000000,
  });
  secondaryIdentity = await idmux({
    name: "endpoint-feedback-other",
    concurrency: 100,
    credits: 1000000,
  });
}, 20000);

// Skipped in self-hosted mode: depends on the production job log tables,
// Autumn refunds, and the per-team daily refund cap.
describeIf(TEST_PRODUCTION)("Generic endpoint feedback tests", () => {
  it("records map feedback, exposes the map job id, and makes duplicate submissions idempotent", async () => {
    const raw = await map(
      { url: TEST_SUITE_WEBSITE, limit: 1, timeout: scrapeTimeout },
      identity,
    );
    expectMapToSucceed(raw);
    expect(typeof raw.body.id).toBe("string");

    const first = await endpointFeedback(
      {
        endpoint: "map",
        jobId: raw.body.id,
        rating: "bad",
        issues: ["missing_expected_url"],
        note: "The map result did not include the canonical page I expected.",
      },
      identity,
    );

    expect(first.success).toBe(true);
    expect(first.creditsRefunded).toBe(1);
    expect(first.alreadySubmitted).toBeFalsy();

    const second = await endpointFeedback(
      {
        endpoint: "map",
        jobId: raw.body.id,
        rating: "partial",
        issues: ["still_missing_expected_url"],
        note: "Submitting twice should not refund twice.",
      },
      identity,
    );

    expect(second.success).toBe(true);
    expect(second.creditsRefunded).toBe(0);
    expect(second.alreadySubmitted).toBe(true);
  }, 120000);

  it("rejects endpoint feedback for a job owned by another team", async () => {
    const raw = await map(
      { url: TEST_SUITE_WEBSITE, limit: 1, timeout: scrapeTimeout },
      identity,
    );
    expectMapToSucceed(raw);

    const failed = await endpointFeedbackWithFailure(
      {
        endpoint: "map",
        jobId: raw.body.id,
        rating: "bad",
        note: "This team should not be able to see the job.",
      },
      secondaryIdentity,
    );

    expect(failed.error.toLowerCase()).toContain("not found");
    expect((failed as any).feedbackErrorCode).toBe("JOB_NOT_FOUND");
  }, 120000);

  it("applies search feedback validation on the generic endpoint", async () => {
    const raw = await searchRawFull(
      { query: "firecrawl generic feedback", limit: 3 },
      identity,
    );
    expect(raw.statusCode).toBe(200);
    expect(typeof raw.body.id).toBe("string");

    const failed = await endpointFeedbackRaw(
      {
        endpoint: "search",
        jobId: raw.body.id,
        rating: "good",
        note: "A good search rating must name a valuable source.",
      },
      identity,
    );

    expect(failed.statusCode).toBe(400);
    expect(failed.body.success).toBe(false);
    expect(String(failed.body.error).toLowerCase()).toContain("invalid");
  }, 90000);

  it("rejects generic search feedback for failed search jobs", async () => {
    const searchId =
      "00000000-0000-7000-8000-" +
      Math.floor(Math.random() * 1e12)
        .toString(16)
        .padStart(12, "0");

    await db.insert(schema.searches).values({
      id: searchId,
      request_id: searchId,
      query: "failed generic feedback search",
      team_id: identity.teamId,
      options: { query: "failed generic feedback search" },
      time_taken: 0,
      credits_cost: 2,
      is_successful: false,
      error: "Synthetic failed search for generic feedback policy coverage.",
      num_results: 0,
    });

    try {
      const failed = await endpointFeedbackRaw(
        {
          endpoint: "search",
          jobId: searchId,
          rating: "bad",
          missingContent: [{ topic: "Results" }],
        },
        identity,
      );

      expect(failed.statusCode).toBe(409);
      expect(failed.body.success).toBe(false);
      expect(failed.body.feedbackErrorCode).toBe("SEARCH_FAILED");
    } finally {
      await db
        .delete(schema.searches)
        .where(
          and(
            eq(schema.searches.id, searchId),
            eq(schema.searches.team_id, identity.teamId),
          ),
        );
    }
  }, 30000);
});
