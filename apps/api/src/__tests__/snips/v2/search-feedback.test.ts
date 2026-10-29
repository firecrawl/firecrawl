import { describeIf, TEST_PRODUCTION } from "../lib";
import {
  searchRawFull,
  searchFeedback,
  searchFeedbackRaw,
  searchFeedbackWithFailure,
  idmux,
  Identity,
} from "./lib";
import { eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { clickhouseClient } from "../../../lib/clickhouse-client";
import {
  readFeedbackJob,
  writeFeedbackJob,
} from "../../../lib/feedback-job-store";

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
      const body = {
        query: "firecrawl",
        objective: "Find official Firecrawl information",
        clientModel: "claude-sonnet-4-6",
        limit: 3,
      };
      const raw = await searchRawFull(body, identity);
      expect(raw.statusCode).toBe(200);
      expect(typeof raw.body.id).toBe("string");
      expect((raw.body.data?.web ?? []).length).toBeGreaterThan(0);

      // The searches row lands in ClickHouse a few seconds after the publish.
      let searchRow: { options: unknown } | undefined;
      for (let attempt = 0; attempt < 30 && !searchRow; attempt++) {
        const result = await clickhouseClient!.query({
          query:
            "SELECT options FROM searches FINAL WHERE id = {id: UUID} AND team_id = {teamId: UUID} AND created_at >= now() - INTERVAL 1 DAY",
          query_params: { id: raw.body.id, teamId: identity.teamId },
          format: "JSONEachRow",
        });
        const [row] = await result.json<{ options: string | null }>();
        if (row) searchRow = { options: JSON.parse(row.options ?? "null") };
        else await new Promise(resolve => setTimeout(resolve, 1000));
      }
      expect(searchRow?.options).toMatchObject({ query: "firecrawl" });
      expect(searchRow?.options).not.toHaveProperty("objective");
      expect(searchRow?.options).not.toHaveProperty("clientModel");

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
      const [feedbackRow] = await db
        .select({ searchId: schema.search_feedback.search_id })
        .from(schema.search_feedback)
        .where(eq(schema.search_feedback.id, result.feedbackId!))
        .limit(1);
      expect(feedbackRow?.searchId).toBe(raw.body.id);
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

      // Back-date the feedback job (its deadline enforces the window) rather
      // than waiting out the configured window.
      let job = await readFeedbackJob(searchId);
      for (let attempt = 0; attempt < 30 && !job; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        job = await readFeedbackJob(searchId);
      }
      expect(job).not.toBeNull();
      expect(
        await writeFeedbackJob({
          endpoint: "search",
          jobId: searchId,
          requestId: job!.requestId,
          teamId: identity.teamId,
          succeeded: job!.succeeded,
          creditsBilled: job!.creditsBilled,
          zeroDataRetention: job!.zeroDataRetention,
          completedAt: new Date(Date.now() - 60 * 60 * 1000),
        }),
      ).toBe(true);

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

  // Positions are bounded and attributed from the feedback job, which is what
  // `lookupFeedbackJob` reads. Seeding it directly is how these tests control
  // the per-source counts without depending on what the live search returned.
  async function seedFeedbackJob(
    searchId: string,
    extra: {
      numResultsBySource?: Record<string, number>;
      resultCategories?: Record<string, Record<string, string>>;
    },
  ) {
    let job = await readFeedbackJob(searchId);
    for (let attempt = 0; attempt < 30 && !job; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      job = await readFeedbackJob(searchId);
    }
    expect(job).not.toBeNull();
    expect(
      await writeFeedbackJob({
        endpoint: "search",
        jobId: searchId,
        requestId: job!.requestId,
        teamId: identity.teamId,
        succeeded: job!.succeeded,
        creditsBilled: job!.creditsBilled,
        zeroDataRetention: job!.zeroDataRetention,
        ...extra,
      }),
    ).toBe(true);
  }

  async function feedbackMetadataFor(feedbackId: string) {
    const [row] = await db
      .select({ metadata: schema.search_feedback.metadata })
      .from(schema.search_feedback)
      .where(eq(schema.search_feedback.id, feedbackId))
      .limit(1);
    expect(row).toBeTruthy();
    return row.metadata as Record<string, unknown>;
  }

  it.concurrent(
    "bounds each group by its own result count",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl grouped bounds", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const searchId = raw.body.id;

      await seedFeedbackJob(searchId, {
        numResultsBySource: { web: 2, images: 0, news: 3 },
      });

      const result = await searchFeedback(
        searchId,
        {
          rating: "good",
          valuableResults: [
            { source: "web", position: 2 },
            // Past the web group, though the combined total leaves room.
            { source: "web", position: 3 },
            { source: "news", position: 3 },
            // images returned nothing, so no position in it is real.
            { source: "images", position: 1 },
          ],
        },
        identity,
      );
      expect(result.success).toBe(true);

      expect(await feedbackMetadataFor(result.feedbackId)).toEqual(
        expect.objectContaining({
          valuableResults: [
            { source: "web", position: 2 },
            { source: "news", position: 3 },
          ],
          valuableResultDocumentIds: [
            `search:${searchId}:web:1`,
            `search:${searchId}:news:2`,
          ],
        }),
      );
    },
    90000,
  );

  it.concurrent(
    "records the serving vertical alongside the position",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl vertical label", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const searchId = raw.body.id;

      await seedFeedbackJob(searchId, {
        numResultsBySource: { web: 2, images: 0, news: 0 },
        resultCategories: { web: { "1": "developer" } },
      });

      const result = await searchFeedback(
        searchId,
        {
          rating: "good",
          valuableResults: [
            { source: "web", position: 1 },
            // Tagged by nothing, so it carries a position but no category.
            { source: "web", position: 2 },
          ],
        },
        identity,
      );
      expect(result.success).toBe(true);

      expect(await feedbackMetadataFor(result.feedbackId)).toEqual(
        expect.objectContaining({
          valuableResults: [
            { source: "web", position: 1, category: "developer" },
            { source: "web", position: 2 },
          ],
        }),
      );
    },
    90000,
  );

  it.concurrent(
    "keeps positions unbounded when the job predates the counts",
    async () => {
      const raw = await searchRawFull(
        { query: "firecrawl legacy job", limit: 3 },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const searchId = raw.body.id;

      // No counts: a job written before the field existed. Unknown bound, so
      // the label is kept rather than discarded.
      await seedFeedbackJob(searchId, {});

      const result = await searchFeedback(
        searchId,
        { rating: "good", valuableResults: [{ source: "news", position: 2 }] },
        identity,
      );
      expect(result.success).toBe(true);

      expect(await feedbackMetadataFor(result.feedbackId)).toEqual(
        expect.objectContaining({
          valuableResults: [{ source: "news", position: 2 }],
          valuableResultDocumentIds: [`search:${searchId}:news:1`],
        }),
      );
    },
    90000,
  );
});
