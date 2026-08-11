import { describeIf, TEST_PRODUCTION } from "../lib";
import {
  searchRawFull,
  searchFeedback,
  searchFeedbackRaw,
  searchFeedbackWithFailure,
  idmux,
  Identity,
} from "./lib";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";

let identity: Identity;
let secondaryIdentity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "search-feedback",
    concurrency: 100,
    credits: 1000000,
  });
  secondaryIdentity = await idmux({
    name: "search-feedback-other",
    concurrency: 100,
    credits: 1000000,
  });
}, 20000);

// Skipped in self-hosted mode: depends on Supabase for the `searches` row
// lookup, Autumn for credit refunds, and the per-team daily refund cap —
// none of which exist in self-hosted setups.
describeIf(TEST_PRODUCTION)("Search feedback tests", () => {
  it.concurrent(
    "records feedback and refunds 1 credit on first submission",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      expect(typeof raw.body.id).toBe("string");
      expect((raw.body.data?.web ?? []).length).toBeGreaterThan(0);

      const result = await searchFeedback(
        raw.body.id,
        {
          rating: "good",
          valuableSources: [
            {
              url: raw.body.data.web[0].url,
              reason: "Most directly answered the question.",
            },
          ],
          valuableResultPositions: [1],
          missingContent: [
            {
              topic: "Enterprise pricing",
              description:
                "Pricing tier table for the Enterprise plan was not in any result.",
            },
            {
              topic: "SLA terms",
              description: "Uptime SLA and support SLAs not surfaced.",
            },
          ],
          querySuggestions:
            "Include site:firecrawl.dev when the user mentions firecrawl by name.",
        },
        identity,
      );

      expect(result.success).toBe(true);
      expect(result.creditsRefunded).toBe(1);
      expect(result.alreadySubmitted).toBeFalsy();
      expect(typeof result.feedbackId).toBe("string");

      const documentId = `search:${raw.body.id}:web:0`;
      const [feedbackRow] = await db
        .select({
          valuable_sources: schema.search_feedback.valuable_sources,
          metadata: schema.search_feedback.metadata,
        })
        .from(schema.search_feedback)
        .where(eq(schema.search_feedback.id, result.feedbackId))
        .limit(1);

      expect(feedbackRow).toBeTruthy();
      expect(feedbackRow.valuable_sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: raw.body.data.web[0].url }),
          expect.objectContaining({
            documentId,
            searchId: raw.body.id,
            resultType: "web",
            resultIndex: 0,
            position: 1,
            source: "position",
          }),
        ]),
      );
      expect(feedbackRow.metadata).toEqual(
        expect.objectContaining({
          valuableResultPositions: [1],
          valuableResultDocumentIds: [documentId],
        }),
      );
    },
    90000,
  );

  // A search that returned nothing can have no valuable positions, so zero is a
  // real bound rather than an "unknown count" that permits any position.
  it.concurrent(
    "drops result positions when the search returned no results",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl zero results bound", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const searchId = raw.body.id;

      await db
        .update(schema.searches)
        .set({ num_results: 0 })
        .where(
          and(
            eq(schema.searches.id, searchId),
            eq(schema.searches.team_id, identity.teamId),
          ),
        );

      const result = await searchFeedback(
        searchId,
        { rating: "good", valuableResultPositions: [1] },
        identity,
      );
      expect(result.success).toBe(true);

      const [feedbackRow] = await db
        .select({
          valuable_sources: schema.search_feedback.valuable_sources,
          metadata: schema.search_feedback.metadata,
        })
        .from(schema.search_feedback)
        .where(eq(schema.search_feedback.id, result.feedbackId))
        .limit(1);

      expect(feedbackRow).toBeTruthy();
      expect(feedbackRow.valuable_sources).toEqual([]);
      expect(feedbackRow.metadata).not.toHaveProperty(
        "valuableResultPositions",
      );
      expect(feedbackRow.metadata).not.toHaveProperty(
        "valuableResultDocumentIds",
      );
    },
    90000,
  );

  // num_results is web+news+images combined, so on a multi-source search it
  // over-counts the web list; `limit` caps each source list independently.
  it.concurrent(
    "bounds result positions by limit when other sources inflate num_results",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl multi source bound", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const searchId = raw.body.id;
      expect((raw.body.data?.web ?? []).length).toBeGreaterThan(0);

      const [searchRow] = await db
        .select({ options: schema.searches.options })
        .from(schema.searches)
        .where(
          and(
            eq(schema.searches.id, searchId),
            eq(schema.searches.team_id, identity.teamId),
          ),
        )
        .limit(1);
      expect(searchRow).toBeTruthy();

      // Stand in for a web+news search that returned 3 of each.
      await db
        .update(schema.searches)
        .set({
          num_results: 6,
          options: {
            ...((searchRow.options as Record<string, unknown> | null) ?? {}),
            limit: 3,
            sources: [{ type: "web" }, { type: "news" }],
          },
        })
        .where(
          and(
            eq(schema.searches.id, searchId),
            eq(schema.searches.team_id, identity.teamId),
          ),
        );

      const result = await searchFeedback(
        searchId,
        { rating: "good", valuableResultPositions: [1, 5] },
        identity,
      );
      expect(result.success).toBe(true);

      const [feedbackRow] = await db
        .select({ metadata: schema.search_feedback.metadata })
        .from(schema.search_feedback)
        .where(eq(schema.search_feedback.id, result.feedbackId))
        .limit(1);

      expect(feedbackRow).toBeTruthy();
      expect(feedbackRow.metadata).toEqual(
        expect.objectContaining({
          valuableResultPositions: [1],
          valuableResultDocumentIds: [`search:${searchId}:web:0`],
        }),
      );
    },
    90000,
  );

  it.concurrent(
    "is idempotent — second submission returns 0 refund",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl docs", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      expect(typeof raw.body.id).toBe("string");

      const first = await searchFeedback(
        raw.body.id,
        {
          rating: "partial",
          missingContent: [
            { topic: "Recent results", description: "Nothing past 2024." },
          ],
        },
        identity,
      );
      expect(first.creditsRefunded).toBe(1);

      const second = await searchFeedback(
        raw.body.id,
        {
          rating: "bad",
          missingContent: [
            {
              topic: "Recent results",
              description: "Still nothing past 2024.",
            },
          ],
        },
        identity,
      );
      expect(second.creditsRefunded).toBe(0);
      expect(second.alreadySubmitted).toBe(true);
    },
    90000,
  );

  it.concurrent(
    "rejects feedback for a search owned by another team",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl api", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const searchId = raw.body.id;

      const failed = await searchFeedbackWithFailure(
        searchId,
        {
          rating: "good",
          valuableSources: [{ url: "https://firecrawl.dev/" }],
        },
        secondaryIdentity,
      );
      expect(failed.error.toLowerCase()).toContain("not found");
      expect((failed as any).feedbackErrorCode).toBe("SEARCH_NOT_FOUND");
    },
    90000,
  );

  it.concurrent(
    "rejects feedback for a non-existent search id",
    async () => {
      const failed = await searchFeedbackWithFailure(
        "00000000-0000-7000-8000-000000000000",
        {
          rating: "bad",
          missingContent: [{ topic: "Anything at all" }],
        },
        identity,
      );
      expect(failed.error.toLowerCase()).toContain("not found");
      expect((failed as any).feedbackErrorCode).toBe("SEARCH_NOT_FOUND");
    },
    30000,
  );

  it.concurrent(
    "rejects an invalid jobId format with 400",
    async () => {
      const raw = await searchFeedbackRaw(
        "not-a-uuid",
        {
          rating: "good",
          valuableSources: [{ url: "https://firecrawl.dev/" }],
        },
        identity,
      );
      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    },
    30000,
  );

  it.concurrent(
    "rejects an invalid rating value",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);

      const failed = await searchFeedbackRaw(
        raw.body.id,
        { rating: "amazing" as any },
        identity,
      );
      expect(failed.statusCode).toBe(400);
      expect(failed.body.success).toBe(false);
    },
    90000,
  );

  it.concurrent(
    "rejects feedback with a non-http URL in valuableSources",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);

      const failed = await searchFeedbackRaw(
        raw.body.id,
        {
          rating: "good",
          valuableSources: [
            { url: "ftp://example.com/file", reason: "valuable" },
          ],
        },
        identity,
      );
      expect(failed.statusCode).toBe(400);
      expect(failed.body.success).toBe(false);
    },
    90000,
  );

  it.concurrent(
    "rejects 'good' rating without any valuableSources",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);

      const failed = await searchFeedbackRaw(
        raw.body.id,
        {
          rating: "good",
          missingContent: [{ topic: "Irrelevant for good rating" }],
        },
        identity,
      );
      expect(failed.statusCode).toBe(400);
      expect(failed.body.success).toBe(false);
      expect(String(failed.body.error).toLowerCase()).toContain("substantive");
    },
    90000,
  );

  it.concurrent(
    "rejects 'partial' rating with no sources and no missing content",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);

      const failed = await searchFeedbackRaw(
        raw.body.id,
        { rating: "partial" },
        identity,
      );
      expect(failed.statusCode).toBe(400);
      expect(failed.body.success).toBe(false);
    },
    90000,
  );

  it.concurrent(
    "rejects 'bad' rating with no missing content or query suggestions",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);

      const failed = await searchFeedbackRaw(
        raw.body.id,
        {
          rating: "bad",
          valuableSources: [{ url: "https://firecrawl.dev/" }],
        },
        identity,
      );
      expect(failed.statusCode).toBe(400);
      expect(failed.body.success).toBe(false);
    },
    90000,
  );

  it.concurrent(
    "rejects missingContent entries without a topic",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);

      const failed = await searchFeedbackRaw(
        raw.body.id,
        {
          rating: "bad",
          // @ts-expect-error testing invalid shape
          missingContent: [{ description: "no topic supplied" }],
        },
        identity,
      );
      expect(failed.statusCode).toBe(400);
      expect(failed.body.success).toBe(false);
    },
    90000,
  );

  it.concurrent(
    "accepts a structured 'partial' rating with multiple missing topics",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl pricing", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);

      const result = await searchFeedback(
        raw.body.id,
        {
          rating: "partial",
          missingContent: [
            {
              topic: "Enterprise pricing",
              description:
                "Pricing tier table for Enterprise was not surfaced.",
            },
            { topic: "Self-hosted pricing" },
            {
              topic: "Annual discount",
              description: "Annual vs monthly discount comparison.",
            },
          ],
        },
        identity,
      );

      expect(result.success).toBe(true);
      expect(result.creditsRefunded).toBe(1);
    },
    90000,
  );

  // TEAM_OPTED_OUT (server-side opt-out via searchFeedbackOptOut flag)
  // is not covered by E2E because idmux identities can't set ACUC flags.

  it.concurrent(
    "stops refunding once the team's daily refund cap is reached",
    async () => {
      const cappedIdentity = await idmux({
        name: "search-feedback-cap",
        concurrency: 100,
        credits: 1000000,
      });

      const dailyCap = 100;

      const seedSearchId =
        "00000000-0000-7000-8000-" +
        Math.floor(Math.random() * 1e12)
          .toString(16)
          .padStart(12, "0");
      await db.insert(schema.search_feedback).values({
        search_id: seedSearchId,
        team_id: cappedIdentity.teamId,
        overall_rating: "good",
        valuable_sources: [{ url: "https://firecrawl.dev/" }],
        missing_content: [],
        integration: null,
        origin: "test-seed",
        credits_refunded: dailyCap,
      });

      // Now do a real search and submit feedback.
      const raw = await searchRawFull(
        { query: "firecrawl daily cap", limit: 3 },
        cappedIdentity,
      );
      expect(raw.statusCode).toBe(200);

      const result = await searchFeedback(
        raw.body.id,
        {
          rating: "good",
          valuableSources: [{ url: raw.body.data.web[0].url }],
        },
        cappedIdentity,
      );

      expect(result.success).toBe(true);
      expect(result.creditsRefunded).toBe(0);
      expect(result.dailyCapReached).toBe(true);
      expect(result.creditsRefundedToday).toBeGreaterThanOrEqual(dailyCap);
      expect(result.dailyRefundCap).toBe(dailyCap);
      expect(String(result.warning ?? "").toLowerCase()).toContain(
        "daily refund cap",
      );

      await db
        .delete(schema.search_feedback)
        .where(eq(schema.search_feedback.search_id, seedSearchId));
    },
    120000,
  );

  // Back-date the searches row so we don't have to wait the full window.
  it.concurrent(
    "rejects feedback submitted outside the configured time window",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl windowed", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const searchId = raw.body.id;

      await new Promise(r => setTimeout(r, 750));
      const aged = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await db
        .update(schema.searches)
        .set({ created_at: aged })
        .where(
          and(
            eq(schema.searches.id, searchId),
            eq(schema.searches.team_id, identity.teamId),
          ),
        );

      const failed = await searchFeedbackWithFailure(
        searchId,
        {
          rating: "good",
          valuableSources: [{ url: "https://firecrawl.dev/" }],
        },
        identity,
      );
      expect((failed as any).feedbackErrorCode).toBe("FEEDBACK_WINDOW_EXPIRED");
    },
    90000,
  );
});
