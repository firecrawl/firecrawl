import { describeIf, TEST_PRODUCTION } from "../lib";
import {
  searchRawFull,
  searchFeedback,
  searchFeedbackRaw,
  searchFeedbackWithFailure,
  idmux,
  Identity,
} from "./lib";
import { supabase_service } from "../../../services/supabase";

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
describeIf(TEST_PRODUCTION)(
  "Search feedback tests",
  () => {
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
              { topic: "Recent results", description: "Still nothing past 2024." },
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
            missingContent: [
              { topic: "Irrelevant for good rating" },
            ],
          },
          identity,
        );
        expect(failed.statusCode).toBe(400);
        expect(failed.body.success).toBe(false);
        expect(String(failed.body.error).toLowerCase()).toContain(
          "substantive",
        );
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
        const { error: seedErr } = await supabase_service
          .from("search_feedback")
          .insert({
            search_id: seedSearchId,
            team_id: cappedIdentity.teamId,
            overall_rating: "good",
            valuable_sources: [{ url: "https://firecrawl.dev/" }],
            missing_content: [],
            integration: null,
            origin: "test-seed",
            credits_refunded: dailyCap,
          });
        expect(seedErr).toBeFalsy();

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

        await supabase_service
          .from("search_feedback")
          .delete()
          .eq("search_id", seedSearchId);
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
        const { error: updateErr } = await supabase_service
          .from("searches")
          .update({ created_at: aged })
          .eq("id", searchId)
          .eq("team_id", identity.teamId);
        expect(updateErr).toBeFalsy();

        const failed = await searchFeedbackWithFailure(
          searchId,
          {
            rating: "good",
            valuableSources: [{ url: "https://firecrawl.dev/" }],
          },
          identity,
        );
        expect((failed as any).feedbackErrorCode).toBe(
          "FEEDBACK_WINDOW_EXPIRED",
        );
      },
      90000,
    );
  },
);
