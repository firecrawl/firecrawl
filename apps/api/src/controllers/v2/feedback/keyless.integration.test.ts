import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";

const fixture = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  db: undefined as ReturnType<typeof drizzle> | undefined,
}));
vi.mock("../../../db/connection", () => ({ db: fixture.db, dbRr: fixture.db }));
vi.mock("../../../lib/spur", () => ({
  isKeylessIpSuspicious: async (ip: string) => ip === "203.0.113.99",
}));

// Opt-in integration database. Each run owns a separate schema on a local server.
const databaseUrl = process.env.KEYLESS_FEEDBACK_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("keyless feedback HTTP and persistence", () => {
  const schemaName = `feedback_test_${randomUUID().replaceAll("-", "")}`;
  let app: express.Express;
  let api: typeof import("./keyless-context");
  let identity: typeof import("../../../lib/keyless");
  let redis: typeof import("../../../services/rate-limiter").redisRateLimitClient;
  let cache: NonNullable<typeof import("./keyless-redis").keylessFeedbackRedis>;
  let table: typeof import("../../../db/schema").search_feedback;
  let config: typeof import("../../../config").config;
  const ip = "203.0.113.71";
  const contextKeys: string[] = [];
  const team = () => identity.keylessTeamUuid(identity.keylessTeamId(ip))!;
  const body = (endpoint: "search" | "scrape" | "parse", jobId: string) => ({
    endpoint,
    jobId,
    rating: "partial",
    task: "Read the API retry documentation",
    assessment: "The output answered part of the retry question.",
    observations:
      endpoint === "search"
        ? [
            {
              kind: "useful",
              basis: "output",
              source: "web",
              position: 1,
              detail: "The reference identifies the supported retry intervals.",
            },
          ]
        : [
            {
              kind: "correct",
              basis: "output",
              detail: "The output includes the documented retry intervals.",
            },
          ],
  });
  const submit = (payload: object, clientIp = ip) =>
    request(app)
      .post("/v2/feedback")
      .set("x-firecrawl-keyless-secret", "feedback-integration-secret")
      .set("x-firecrawl-keyless-ip", clientIp)
      .send(payload);
  async function job(
    endpoint: "search" | "scrape" | "parse",
    success = true,
    clientIp = ip,
  ) {
    const jobId = randomUUID();
    const owner = identity.keylessTeamUuid(identity.keylessTeamId(clientIp))!;
    const response = new EventEmitter();
    const metadata = await api.keylessFeedbackMetadata(
      {
        res: response,
        auth: { team_id: identity.keylessTeamId(clientIp) },
        body: {
          query: "retry behavior",
          categories: ["developer"],
          headers: { Authorization: "redact-me" },
          apiKey: "redact-me",
          uploadRef: "redact-me",
          file: { filename: "fixture.html", kind: "html", buffer: "redact-me" },
        },
      } as any,
      endpoint,
      jobId,
      success,
      endpoint === "search"
        ? {
            web: [
              {
                url: "https://example.com/retry",
                category: "developer",
                title: "Retries",
              },
            ],
            news: [],
          }
        : { markdown: "Retry with exponential backoff." },
    );
    contextKeys.push(api.keylessFeedbackContextKey(owner, endpoint, jobId));
    expect(metadata.jobId).toBe(jobId);
    response.emit("finish");
    if (metadata.feedback)
      await vi.waitFor(async () => {
        const stored = JSON.parse(
          (await cache.get(
            api.keylessFeedbackContextKey(owner, endpoint, jobId),
          ))!,
        );
        expect(stored.invited).toBe(true);
      });
    return { jobId, metadata };
  }
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1"].includes(new URL(databaseUrl!).hostname))
      throw new Error("Integration database must be local.");
    fixture.pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName} -c timezone=America/Los_Angeles`,
    });
    await fixture.pool.query(`CREATE SCHEMA ${schemaName}`);
    fixture.db = drizzle({ client: fixture.pool });
    ({ config } = await import("../../../config.js"));
    config.USE_DB_AUTHENTICATION = true;
    config.KEYLESS_FEEDBACK_ENABLED = true;
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 1;
    config.KEYLESS_PROXY_SECRET = "feedback-integration-secret";
    identity = await import("../../../lib/keyless.js");
    ({ redisRateLimitClient: redis } = await import(
      "../../../services/rate-limiter.js"
    ));
    ({ search_feedback: table } = await import("../../../db/schema/index.js"));
    api = await import("./keyless-context.js");
    cache = (await import("./keyless-redis.js")).keylessFeedbackRedis!;
    await vi.waitFor(() => expect(cache.status).toBe("ready"));
    await fixture.pool.query(`CREATE TABLE search_feedback (
      id uuid PRIMARY KEY, search_id uuid UNIQUE, endpoint text NOT NULL DEFAULT 'search', job_id uuid,
      request_id uuid, api_version text DEFAULT 'v2', team_id uuid NOT NULL, api_key_id bigint,
      overall_rating text NOT NULL, issue_types text[] NOT NULL DEFAULT '{}', tags text[] NOT NULL DEFAULT '{}',
      comment text, valuable_sources jsonb NOT NULL DEFAULT '[]', missing_content jsonb NOT NULL DEFAULT '[]',
      query_suggestions text, metadata jsonb NOT NULL DEFAULT '{}', job_status text,
      credits_billed integer NOT NULL DEFAULT 0, integration text, origin text,
      credits_refunded integer NOT NULL DEFAULT 0, refund_policy jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(team_id, endpoint, job_id))`);
    const { authMiddleware } = await import("../../../routes/shared.js");
    const { RateLimiterMode } = await import("../../../types.js");
    const { feedbackController } = await import("./controller.js");
    app = express();
    app.use(express.json());
    app.post("/test/jobs/:endpoint/:jobId", async (req, res) => {
      const metadata = await api.keylessFeedbackMetadata(
        Object.assign(req, {
          auth: { team_id: identity.keylessTeamId(ip) },
        }) as any,
        req.params.endpoint as "search" | "scrape" | "parse",
        req.params.jobId,
        true,
        { markdown: "Observed document content." },
      );
      res.json({ success: true, metadata });
    });
    app.post(
      "/v2/feedback",
      authMiddleware(RateLimiterMode.Account, {
        allowKeyless: true,
        keylessFeedback: true,
      }),
      feedbackController as any,
    );
  });
  beforeEach(async () => {
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 1;
    await fixture.pool!.query("DELETE FROM search_feedback");
    await redis.del(`keyless_feedback_attempts:${team()}`);
    await cache.del(
      `keyless_feedback_invitations:${team()}:search`,
      `keyless_feedback_invitations:${team()}:scrape`,
      `keyless_feedback_invitations:${team()}:parse`,
    );
  });
  afterAll(async () => {
    if (redis) {
      if (contextKeys.length) await cache.del(...contextKeys);
      await redis.del(
        `keyless_requests:${ip}`,
        `keyless_credits:${ip}`,
        `keyless_feedback_attempts:${team()}`,
      );
      await cache.del(
        ...["search", "scrape", "parse"].map(
          category => `keyless_feedback_invitations:${team()}:${category}`,
        ),
      );
    }
    if (fixture.pool) {
      await fixture.pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
      await fixture.pool.end();
    }
  });

  it.each(["search", "scrape", "parse"] as const)(
    "shares the daily limit across categories and clients after accepting %s feedback with operation quota exhausted",
    async endpoint => {
      await redis.set(`keyless_requests:${ip}`, "100000");
      await redis.set(`keyless_credits:${ip}`, "100000");
      const { jobId, metadata } = await job(endpoint);
      expect(metadata.feedback).toBeDefined();
      const accepted = await submit({
        ...body(endpoint, jobId),
        origin: "mcp",
        integration: "cli",
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body.creditsRefunded).toBe(0);
      const retry = await submit({ ...body(endpoint, jobId), origin: "api" });
      expect(retry.status).toBe(200);
      expect(retry.body.alreadySubmitted).toBe(true);
      expect(retry.body.feedbackId).toBe(accepted.body.feedbackId);
      for (const category of ["search", "scrape", "parse"] as const) {
        const next = await job(category);
        expect(next.metadata.feedback).toBeUndefined();
        const rejected = await submit({
          ...body(category, next.jobId),
          origin: "cli",
        });
        expect(rejected.status).toBe(429);
        expect(rejected.body.feedbackErrorCode).toBe("DAILY_LIMIT_REACHED");
      }
      expect(await redis.get(`keyless_requests:${ip}`)).toBe("100000");
      expect(await redis.get(`keyless_credits:${ip}`)).toBe("100000");
      const rows = await fixture.db!.select().from(table);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({
        version: "keyless_feedback_v1",
        answers: { origin: "mcp", integration: "cli" },
        context: {
          invited: true,
          request: {
            categories: ["developer"],
            file: { filename: "fixture.html", kind: "html" },
          },
        },
      });
      expect(JSON.stringify(rows)).not.toContain("redact-me");
    },
  );
  it("stores snapshots on a separate Redis server and records nonresponders after HTTP response completion", async () => {
    const jobId = randomUUID();
    const key = api.keylessFeedbackContextKey(team(), "scrape", jobId);
    contextKeys.push(key);
    const response = await request(app)
      .post(`/test/jobs/scrape/${jobId}`)
      .send({ origin: "cli", integration: "cli" });
    expect(response.body.metadata.feedback).toBeDefined();
    await vi.waitFor(async () =>
      expect(JSON.parse((await cache.get(key))!).invited).toBe(true),
    );
    expect(await cache.ttl(key)).toBeGreaterThan(86000);
    expect(await redis.get(key)).toBeNull();
    expect(
      await redis.get(`keyless_feedback_invitations:${team()}:scrape`),
    ).toBeNull();
    expect(await fixture.db!.select().from(table)).toHaveLength(0);
    const runId = (info: string) => info.match(/^run_id:(.+)$/m)?.[1];
    expect(runId(await cache.info("server"))).not.toBe(
      runId(await redis.info("server")),
    );
    await redis.set(`keyless_requests:${ip}`, "100000");
    await cache.del(key);
    expect((await submit(body("scrape", jobId))).status).toBe(404);
    expect(await redis.get(`keyless_requests:${ip}`)).toBe("100000");
  });

  it("preserves a non-invited context for a client that opts out at the API", async () => {
    const jobId = randomUUID();
    const key = api.keylessFeedbackContextKey(team(), "parse", jobId);
    contextKeys.push(key);
    const response = await request(app)
      .post(`/test/jobs/parse/${jobId}`)
      .set("x-firecrawl-no-feedback", "1")
      .send({});
    expect(response.body.metadata).toEqual({ jobId });
    expect(JSON.parse((await cache.get(key))!).invited).toBe(false);
    expect(
      await cache.get(`keyless_feedback_invitations:${team()}:parse`),
    ).toBeNull();
  });
  it("suppresses invitations and rejects submissions when disabled", async () => {
    const { jobId } = await job("scrape");
    config.KEYLESS_FEEDBACK_ENABLED = false;
    try {
      const metadata = await api.keylessFeedbackMetadata(
        { auth: { team_id: identity.keylessTeamId(ip) }, body: {} } as any,
        "scrape",
        randomUUID(),
        true,
        { markdown: "Example" },
      );
      expect(metadata).toEqual({});
      expect((await submit(body("scrape", jobId))).status).toBe(503);
      expect(await fixture.db!.select().from(table)).toHaveLength(0);
    } finally {
      config.KEYLESS_FEEDBACK_ENABLED = true;
    }
  });

  it("serializes simultaneous submissions across categories and clients", async () => {
    const endpoints = [
      "search",
      "scrape",
      "parse",
      "search",
      "scrape",
      "parse",
    ] as const;
    const jobs = await Promise.all(
      endpoints.map(async endpoint => ({ endpoint, ...(await job(endpoint)) })),
    );
    const responses = await Promise.all(
      jobs.map(({ endpoint, jobId }, index) =>
        submit({
          ...body(endpoint, jobId),
          origin: ["api", "mcp", "cli"][index % 3],
        }),
      ),
    );
    expect(responses.filter(response => response.status === 200)).toHaveLength(
      1,
    );
    expect(responses.filter(response => response.status === 429)).toHaveLength(
      5,
    );
    expect(
      responses
        .filter(response => response.status === 429)
        .every(
          response => response.body.feedbackErrorCode === "DAILY_LIMIT_REACHED",
        ),
    ).toBe(true);
    expect(await fixture.db!.select().from(table)).toHaveLength(1);
  });
  it("rejects another identity, wrong category, nonexistent positions and malformed evidence without using the daily slot", async () => {
    const { jobId } = await job("search");
    expect((await submit(body("search", jobId), "203.0.113.72")).status).toBe(
      404,
    );
    expect((await submit(body("parse", jobId))).status).toBe(404);
    const invalid = body("search", jobId);
    (invalid.observations[0] as any).source = "news";
    expect((await submit(invalid)).status).toBe(400);
    expect(
      (await submit({ endpoint: "search", jobId, rating: "good" })).status,
    ).toBe(400);
    expect((await submit(body("search", jobId))).status).toBe(200);
  });
  it("ignores untrusted identity headers", async () => {
    const { jobId } = await job("parse");
    const result = await request(app)
      .post("/v2/feedback")
      .set("x-firecrawl-keyless-ip", ip)
      .set("x-firecrawl-keyless-secret", "incorrect-secret")
      .send(body("parse", jobId));
    expect(result.status).toBe(404);
    expect(await fixture.db!.select().from(table)).toHaveLength(0);
  });
  it("returns the same record for concurrent retries", async () => {
    const { jobId } = await job("parse");
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => submit(body("parse", jobId))),
    );
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(
      new Set(responses.map(response => response.body.feedbackId)).size,
    ).toBe(1);
    expect(await fixture.db!.select().from(table)).toHaveLength(1);
  });
  it("configures invitation frequency without disabling job references", async () => {
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 3;
    expect((await job("parse")).metadata.feedback).toBeUndefined();
    expect((await job("parse")).metadata.feedback).toBeUndefined();
    expect((await job("parse")).metadata.feedback).toBeDefined();
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 0;
    expect((await job("parse")).metadata.feedback).toBeUndefined();
  });
  it("bounds waiting when optional context storage is unavailable", async () => {
    const set = vi
      .spyOn(cache, "set")
      .mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    try {
      expect(
        await api.keylessFeedbackMetadata(
          { auth: { team_id: identity.keylessTeamId(ip) }, body: {} } as any,
          "parse",
          randomUUID(),
          true,
          {},
        ),
      ).toEqual({});
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      set.mockRestore();
    }
  });
  it("accepts a failed scrape with task intent and only the observed failure", async () => {
    const { jobId } = await job("scrape", false);
    const result = await submit({
      ...body("scrape", jobId),
      observations: [
        {
          kind: "failure",
          basis: "output",
          detail: "The request timed out with no returned content.",
        },
      ],
    });
    expect(result.status).toBe(200);
    const [row] = await fixture.db!.select().from(table);
    expect(row.job_status).toBe("failed");
  });
  it("throttles malformed attempts separately and rejects blocked or invalid identities", async () => {
    for (let i = 0; i < 10; i++) expect((await submit({})).status).toBe(400);
    expect((await submit({})).status).toBe(429);
    const invitation = await job("scrape");
    expect(invitation.metadata.feedback).toBeUndefined();
    expect((await submit({}, "203.0.113.99")).status).toBe(403);
    expect((await submit({}, "not-an-ip")).status).toBe(401);
    expect(await fixture.db!.select().from(table)).toHaveLength(0);
  });
  it("uses the same identity for IPv4-mapped addresses", async () => {
    const { jobId } = await job("parse");
    expect((await submit(body("parse", jobId), `::ffff:${ip}`)).status).toBe(
      200,
    );
    expect((await submit(body("parse", jobId))).body.alreadySubmitted).toBe(
      true,
    );
  });
  it("does not consume today's slot for a submission before UTC midnight", async () => {
    const first = await job("scrape");
    expect((await submit(body("scrape", first.jobId))).status).toBe(200);
    await fixture
      .db!.update(table)
      .set({
        created_at: sql`(date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 microsecond'`,
      })
      .where(eq(table.team_id, team()));
    expect(
      (await submit(body("scrape", first.jobId))).body.alreadySubmitted,
    ).toBe(true);
    const second = await job("parse");
    expect(second.metadata.feedback).toBeDefined();
    expect((await submit(body("parse", second.jobId))).status).toBe(200);
  });
  it("keeps the daily allowance independent for different identities", async () => {
    const otherIp = "203.0.113.73";
    const otherIdentity = identity.keylessTeamUuid(
      identity.keylessTeamId(otherIp),
    )!;
    try {
      const first = await job("search");
      expect((await submit(body("search", first.jobId))).status).toBe(200);
      const second = await job("search", true, otherIp);
      expect(second.metadata.feedback).toBeDefined();
      expect((await submit(body("search", second.jobId), otherIp)).status).toBe(
        200,
      );
      expect(await fixture.db!.select().from(table)).toHaveLength(2);
    } finally {
      await redis.del(`keyless_feedback_attempts:${otherIdentity}`);
      await cache.del(`keyless_feedback_invitations:${otherIdentity}:search`);
    }
  });
  it("rolls back failed persistence without burning the daily slot", async () => {
    const { jobId } = await job("parse");
    await fixture.pool!.query(
      "ALTER TABLE search_feedback ADD CONSTRAINT reject_fixture CHECK (endpoint <> 'parse')",
    );
    expect((await submit(body("parse", jobId))).status).toBe(503);
    await fixture.pool!.query(
      "ALTER TABLE search_feedback DROP CONSTRAINT reject_fixture",
    );
    expect((await submit(body("parse", jobId))).status).toBe(200);
  });
  it("bounds context lifetime and skips zero-retention jobs", async () => {
    const { jobId } = await job("scrape");
    const key = api.keylessFeedbackContextKey(team(), "scrape", jobId);
    const stored = JSON.parse((await cache.get(key))!);
    stored.createdAt = new Date(Date.now() - 86401 * 1000).toISOString();
    await cache.set(key, JSON.stringify(stored));
    expect((await submit(body("scrape", jobId))).body.feedbackErrorCode).toBe(
      "FEEDBACK_WINDOW_EXPIRED",
    );
    expect(
      await api.keylessFeedbackMetadata(
        {
          auth: { team_id: identity.keylessTeamId(ip) },
          body: { zeroDataRetention: true },
        } as any,
        "scrape",
        randomUUID(),
        true,
        {},
      ),
    ).toEqual({});
  });
});
