import { eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import { search_feedback } from "../../../db/schema";
import { keylessTeamId, keylessTeamUuid } from "../../../lib/keyless";
import { redisRateLimitClient } from "../../../services/rate-limiter";
import { keylessFeedbackRedis } from "../../../controllers/v2/feedback/keyless-redis";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { config } from "../../../config";
import {
  describeIf,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrapeTimeout } from "./lib";

const enabled =
  TEST_PRODUCTION &&
  config.KEYLESS_FEEDBACK_ENABLED &&
  !!keylessFeedbackRedis &&
  !!config.KEYLESS_PROXY_SECRET &&
  config.KEYLESS_REQUESTS_PER_DAY !== undefined &&
  config.KEYLESS_CREDITS_PER_DAY !== undefined;

describeIf(enabled)("keyless feedback", () => {
  const identity = keylessTeamUuid(keylessTeamId("203.0.113.173"))!;
  const cleanup = async () => {
    await db
      .delete(search_feedback)
      .where(eq(search_feedback.team_id, identity));
    await redisRateLimitClient.del(
      "keyless_requests:203.0.113.173",
      "keyless_credits:203.0.113.173",
      `keyless_feedback_attempts:${identity}`,
    );
    await keylessFeedbackRedis!.del(`keyless_feedback_invitations:${identity}`);
  };
  beforeEach(cleanup);
  afterAll(cleanup);

  const call = (path: string, body: object) =>
    request(TEST_API_URL)
      .post(path)
      .set("x-firecrawl-keyless-secret", config.KEYLESS_PROXY_SECRET!)
      .set("x-firecrawl-keyless-ip", "203.0.113.173")
      .send(body);

  it(
    "preserves a scrape job reference and accepts evidence without an API key",
    async () => {
      const scraped = await call("/v2/scrape", {
        url: TEST_SUITE_WEBSITE,
        formats: ["markdown"],
        timeout: scrapeTimeout,
      });
      expect(scraped.status).toBe(200);
      expect(scraped.body.data.markdown.trim().length).toBeGreaterThan(0);
      const jobId = scraped.body.data.metadata.jobId;
      expect(jobId).toEqual(expect.any(String));
      const payload = {
        endpoint: "scrape",
        jobId,
        rating: "good",
        task: "Read the test page as markdown",
        assessment:
          "The response provided nonempty markdown for the test page.",
        observations: [
          {
            kind: "correct",
            basis: "output",
            detail:
              "The response included a markdown field containing page text.",
          },
        ],
      };
      const accepted = await call("/v2/feedback", payload);
      expect(accepted.status).toBe(200);
      const duplicate = await call("/v2/feedback", payload);
      expect(duplicate.body.feedbackId).toBe(accepted.body.feedbackId);
      expect(duplicate.body.alreadySubmitted).toBe(true);
      expect(accepted.body.creditsRefunded).toBe(0);
    },
    scrapeTimeout,
  );

  it(
    "links a parsed upload to substantive feedback",
    async () => {
      const parsed = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("x-firecrawl-keyless-secret", config.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", "203.0.113.173")
        .field(
          "options",
          JSON.stringify({ formats: ["markdown"], timeout: scrapeTimeout }),
        )
        .attach(
          "file",
          Buffer.from(
            "<html><body><h1>Retry reference</h1><p>Retry after one second.</p></body></html>",
          ),
          { filename: "reference.html", contentType: "text/html" },
        );
      expect(parsed.status).toBe(200);
      expect(parsed.body.data.markdown).toContain("Retry after one second");
      const submitted = await call("/v2/feedback", {
        endpoint: "parse",
        docClass: "unknown",
        jobId: parsed.body.data.metadata.jobId,
        rating: "good",
        task: "Read the retry interval from an uploaded reference",
        assessment: "The parsed output preserves the documented interval.",
        observations: [
          {
            kind: "correct",
            basis: "source_comparison",
            detail:
              "The output contains the same one-second retry interval as the uploaded HTML.",
            comparison: {
              reference: "reference.html, paragraph below Retry reference",
              detail:
                "The source and returned markdown both say to retry after one second.",
            },
          },
        ],
      });
      expect(submitted.status).toBe(200);
      expect(submitted.body.feedbackId).toEqual(expect.any(String));
    },
    scrapeTimeout,
  );

  it("rejects a missing originating job and assessment-only feedback", async () => {
    const payload = {
      endpoint: "parse",
      docClass: "unknown",
      jobId: randomUUID(),
      rating: "partial",
      task: "Extract a document table",
      assessment: "The table lacked column headings.",
      observations: [
        {
          kind: "table",
          reason: "structure",
          basis: "output",
          detail: "The output table did not include any column headings.",
        },
      ],
    };
    expect((await call("/v2/feedback", payload)).status).toBe(404);
    expect(
      (await call("/v2/feedback", { ...payload, observations: [] })).status,
    ).toBe(400);
  });
});
