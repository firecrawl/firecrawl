import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const fixture = vi.hoisted(() => ({
  db: undefined as ReturnType<typeof drizzle> | undefined,
  jobs: new Map<string, unknown>(),
  refundCredits: vi.fn(
    async (_args: {
      value: number;
      idempotencyKey: string;
      properties: { jobId: string };
    }) => true,
  ),
}));
vi.mock("../../../db/connection", () => ({ db: fixture.db, dbRr: fixture.db }));
vi.mock("../../../lib/feedback-job-store", () => ({
  readFeedbackJob: async (jobId: string) => fixture.jobs.get(jobId) ?? null,
}));
vi.mock("../../../services/autumn/autumn.service", () => ({
  CREDITS_FEATURE_ID: "CREDITS",
  SEARCH_CREDITS_FEATURE_ID: "SEARCH_CREDITS",
  featureIdForBillingEndpoint: () => "CREDITS",
  autumnService: { refundCredits: fixture.refundCredits },
}));

// Opt in with a local PostgreSQL database. Each run owns an isolated schema
// holding the search_feedback columns and both of its unique indexes, which
// are what make a repeated submission collide.
const databaseUrl = process.env.FEEDBACK_TEST_DATABASE_URL;
const ddl = `
CREATE TABLE search_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  search_id uuid,
  endpoint text NOT NULL DEFAULT 'search',
  job_id uuid,
  request_id uuid,
  api_version text DEFAULT 'v2',
  team_id uuid NOT NULL,
  api_key_id bigint,
  overall_rating text NOT NULL CHECK (overall_rating IN ('good', 'bad', 'partial')),
  issue_types text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  comment text,
  valuable_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_content jsonb NOT NULL DEFAULT '[]'::jsonb,
  query_suggestions text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  job_status text,
  credits_billed int NOT NULL DEFAULT 0,
  integration text,
  origin text,
  credits_refunded int4 NOT NULL DEFAULT 0,
  refund_policy jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX search_feedback_search_id_unique_idx ON search_feedback (search_id);
CREATE UNIQUE INDEX search_feedback_once_per_job_idx ON search_feedback (team_id, endpoint, job_id);
`;

const suite = databaseUrl ? describe : describe.skip;
suite("repeated feedback submissions against PostgreSQL", () => {
  const schemaName = `endpoint_feedback_${randomUUID().replaceAll("-", "")}`;
  const teamId = randomUUID();
  let pool: Pool;
  let admin: Pool;
  let app: express.Express;
  let config: typeof import("../../../config").config;
  let originalAuthentication: boolean | undefined;

  function addJob(refundClass: "search" | "scrape_basic"): string {
    const jobId = randomUUID();
    fixture.jobs.set(jobId, {
      requestId: randomUUID(),
      teamId,
      refundClass,
      feedbackDeadlineMs: Date.now() + 10 * 60 * 1000,
      succeeded: true,
      creditsBilled: 2,
      zeroDataRetention: false,
    });
    return jobId;
  }

  const searchBody = {
    rating: "good",
    valuableSources: [{ url: "https://example.com/", reason: "Answered it." }],
  };
  const scrapeBody = (jobId: string) => ({
    endpoint: "scrape",
    jobId,
    rating: "partial",
    note: "The pricing table was missing.",
  });
  const submitSearch = (searchId: string) =>
    request(app).post(`/v2/search/${searchId}/feedback`).send(searchBody);
  const submitJob = (jobId: string) =>
    request(app).post("/v2/feedback").send(scrapeBody(jobId));

  async function rows(jobId: string) {
    const result = await pool.query(
      "SELECT id, credits_refunded FROM search_feedback WHERE job_id = $1",
      [jobId],
    );
    return result.rows;
  }

  function refundsFor(jobId: string) {
    return fixture.refundCredits.mock.calls.filter(
      ([args]) => args.properties.jobId === jobId,
    );
  }

  beforeAll(async () => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(databaseUrl!).hostname,
      )
    ) {
      throw new Error("Feedback integration tests require a local database");
    }
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
    });
    await pool.query(ddl);
    fixture.db = drizzle({ client: pool });
    config = (await import("../../../config.js")).config;
    originalAuthentication = config.USE_DB_AUTHENTICATION;
    config.USE_DB_AUTHENTICATION = true;
    const { feedbackController } = await import("./controller.js");
    const { searchFeedbackController } = await import("../search-feedback.js");
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        auth: { team_id: teamId },
        acuc: { flags: {}, api_key_id: 42, org_id: "org-test" },
      });
      next();
    });
    app.post("/v2/feedback", feedbackController as any);
    app.post("/v2/search/:jobId/feedback", searchFeedbackController as any);
  });

  afterAll(async () => {
    if (config) config.USE_DB_AUTHENTICATION = originalAuthentication;
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await admin.end();
    }
  });

  it.each([
    ["search feedback", "search" as const, submitSearch],
    ["job feedback", "scrape_basic" as const, submitJob],
  ])(
    "answers a repeated %s with alreadySubmitted and refunds once",
    async (_label, refundClass, submit) => {
      const jobId = addJob(refundClass);

      const first = await submit(jobId);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ success: true, creditsRefunded: 1 });
      expect(first.body.alreadySubmitted).toBeUndefined();

      const second = await submit(jobId);
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body).toMatchObject({
        success: true,
        alreadySubmitted: true,
        creditsRefunded: 0,
        feedbackId: first.body.feedbackId,
      });

      expect(refundsFor(jobId)).toHaveLength(1);
      expect(refundsFor(jobId)[0][0]).toMatchObject({
        idempotencyKey: `fc:refund:feedback:${first.body.feedbackId}`,
        value: 1,
      });
      expect(await rows(jobId)).toEqual([
        { id: first.body.feedbackId, credits_refunded: 1 },
      ]);
    },
  );

  it.each([
    ["search feedback", "search" as const, submitSearch],
    ["job feedback", "scrape_basic" as const, submitJob],
  ])(
    "lets one of two concurrent identical %s submissions win and refunds once",
    async (_label, refundClass, submit) => {
      const jobId = addJob(refundClass);

      const responses = await Promise.all([submit(jobId), submit(jobId)]);
      expect(
        responses.map(response => response.status),
        JSON.stringify(responses.map(response => response.body)),
      ).toEqual([200, 200]);
      const winners = responses.filter(
        response => !response.body.alreadySubmitted,
      );
      const duplicates = responses.filter(
        response => response.body.alreadySubmitted,
      );
      expect(winners).toHaveLength(1);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].body.creditsRefunded).toBe(0);

      expect(refundsFor(jobId)).toHaveLength(1);
      expect(await rows(jobId)).toEqual([
        { id: winners[0].body.feedbackId, credits_refunded: 1 },
      ]);
    },
  );
});
