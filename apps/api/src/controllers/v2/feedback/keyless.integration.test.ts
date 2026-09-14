import express from "express";
import { EventEmitter } from "node:events";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";

const fixture = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  refund: vi.fn(),
  results: new Map<string, unknown>(),
  readResult: vi.fn<(id: string) => Promise<unknown>>(),
  db: undefined as ReturnType<typeof drizzle> | undefined,
}));
vi.mock("../../../db/connection", () => ({ db: fixture.db, dbRr: fixture.db }));
vi.mock("../../../lib/spur", () => ({
  isKeylessIpSuspicious: async (ip: string) => ip === "203.0.113.99",
}));

vi.mock("../../../lib/gcs-jobs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/gcs-jobs")>()),
  saveSearchToGCS: async (search: { id: string; results: unknown }) => {
    fixture.results.set(search.id, structuredClone(search.results));
  },
  getJobFromGCS: fixture.readResult,
}));
vi.mock("../../../services/posthog", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/posthog")>()),
  trackFirstSurfaceUse: vi.fn(),
}));

// Opt-in integration database. Each run owns a separate schema on a local server.
const databaseUrl = process.env.KEYLESS_FEEDBACK_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("keyless feedback HTTP and persistence", () => {
  const schemaName = `feedback_test_${randomUUID().replaceAll("-", "")}`;
  let app: express.Express;
  let api: typeof import("./keyless-invitation");
  let identity: typeof import("../../../lib/keyless");
  let redis: typeof import("../../../services/rate-limiter").redisRateLimitClient;
  let logging: typeof import("../../../services/logging/log_job");
  let table: typeof import("../../../db/schema").search_feedback;
  let config: typeof import("../../../config").config;
  const ip = "203.0.113.71";
  const authenticatedTeam = randomUUID();
  const orgId = randomUUID();
  const team = () => identity.keylessTeamUuid(identity.keylessTeamId(ip))!;
  const body = (endpoint: "search" | "scrape" | "parse", jobId: string) => ({
    endpoint,
    jobId,
    ...(endpoint === "parse" ? { docClass: "unknown" } : {}),
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
  async function persistJob(
    endpoint: "search" | "scrape" | "parse",
    jobId: string,
    options: Record<string, unknown> = {},
    success = true,
    clientIp = ip,
  ) {
    const owner = identity.keylessTeamId(clientIp);
    const zeroDataRetention =
      options.zeroDataRetention === true ||
      (Array.isArray(options.enterprise) && options.enterprise.includes("zdr"));
    await logging.logRequest({
      id: jobId,
      kind: endpoint,
      api_version: "v2",
      team_id: owner,
      origin: "api",
      target_hint: "https://example.com/retry",
      zeroDataRetention,
    });
    if (endpoint === "search") {
      await logging.logSearch({
        id: jobId,
        request_id: jobId,
        team_id: owner,
        query: "retry behavior",
        options,
        is_successful: success,
        time_taken: 0.1,
        credits_cost: 0,
        num_results: 1,
        zeroDataRetention,
        results: {
          web: [
            {
              url: "https://example.com/retry",
              category: "developer",
              title: "Retries",
            },
          ],
          news: [],
        },
      });
    } else {
      await logging.logScrape({
        id: jobId,
        request_id: jobId,
        team_id: owner,
        url: "https://example.com/retry",
        options: options as any,
        is_successful: success,
        time_taken: 0.1,
        credits_cost: 0,
        skipNuq: true,
        zeroDataRetention,
        is_parse: endpoint === "parse",
      });
    }
  }
  async function job(
    endpoint: "search" | "scrape" | "parse",
    success = true,
    clientIp = ip,
    options: Record<string, unknown> = {},
  ) {
    const jobId = randomUUID();
    const savedOptions = {
      ...options,
      query: "retry behavior",
      privateFixture: "job-private-content",
    };
    await persistJob(endpoint, jobId, savedOptions, success, clientIp);
    const response = new EventEmitter();
    const metadata = await api.keylessFeedbackMetadata(
      {
        res: response,
        auth: { team_id: identity.keylessTeamId(clientIp) },
        body: savedOptions,
      } as any,
      endpoint,
      jobId,
      success,
    );
    expect(metadata.jobId).toBe(jobId);
    response.emit("finish");
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
    config.PUBSUB_CREDENTIALS = undefined;
    config.KEYLESS_FEEDBACK_ENABLED = true;
    config.FEEDBACK_REFUND_ENABLED = true;
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 1;
    config.KEYLESS_PROXY_SECRET = "feedback-integration-secret";
    identity = await import("../../../lib/keyless.js");
    ({ redisRateLimitClient: redis } = await import(
      "../../../services/rate-limiter.js"
    ));
    ({ search_feedback: table } = await import("../../../db/schema/index.js"));
    api = await import("./keyless-invitation.js");
    logging = await import("../../../services/logging/log_job.js");
    await vi.waitFor(() => expect(redis.status).toBe("ready"));
    await fixture.pool.query(`CREATE TABLE requests (
      id uuid PRIMARY KEY, kind text, api_version text, external_request_id text,
      team_id uuid, origin text, integration text, target_hint text, dr_clean_by timestamptz,
      api_key_id bigint, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await fixture.pool.query(`CREATE TABLE searches (
      id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES requests(id), team_id uuid NOT NULL,
      query text, options jsonb, num_results integer, is_successful boolean,
      error text, credits_cost integer, time_taken numeric, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const name of ["scrapes", "parses"]) {
      await fixture.pool.query(`CREATE TABLE ${name} (
        id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES requests(id), team_id uuid NOT NULL,
        url text, options jsonb, is_successful boolean, error text, credits_cost integer,
        time_taken numeric, created_at timestamptz NOT NULL DEFAULT now(), cost_tracking jsonb,
        pdf_num_pages integer, content_type text, monitor_id uuid, monitor_check_id uuid
      )`);
    }
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
    const { searchFeedbackController } = await import("../search-feedback.js");
    const { autumnService } = await import(
      "../../../services/autumn/autumn.service.js"
    );
    vi.spyOn(autumnService, "refundCredits").mockImplementation(fixture.refund);
    app = express();
    app.use(express.json());
    const authenticated: express.RequestHandler = (req, _res, next) => {
      Object.assign(req, {
        auth: { team_id: authenticatedTeam },
        acuc: { org_id: orgId, flags: {} },
      });
      next();
    };
    app.post(
      "/test/authenticated/feedback",
      authenticated,
      feedbackController as any,
    );
    app.post(
      "/test/authenticated/search/:jobId/feedback",
      authenticated,
      searchFeedbackController as any,
    );
    app.post("/test/jobs/:endpoint/:jobId", async (req, res) => {
      await persistJob(
        req.params.endpoint as "search" | "scrape" | "parse",
        req.params.jobId,
        req.body,
      );
      const metadata = await api.keylessFeedbackMetadata(
        Object.assign(req, {
          auth: { team_id: identity.keylessTeamId(ip) },
        }) as any,
        req.params.endpoint as "search" | "scrape" | "parse",
        req.params.jobId,
        true,
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
    fixture.refund.mockReset().mockResolvedValue(undefined);
    fixture.results.clear();
    fixture.readResult
      .mockReset()
      .mockImplementation(async id => fixture.results.get(id) ?? null);
    await fixture.pool!.query(
      "TRUNCATE search_feedback, searches, scrapes, parses, requests CASCADE",
    );
    await redis.del(`keyless_feedback_attempts:${team()}`);
    await redis.del(`keyless_feedback_invitations:${team()}`);
  });
  afterAll(async () => {
    if (redis) {
      await redis.del(
        `keyless_requests:${ip}`,
        `keyless_credits:${ip}`,
        `keyless_feedback_attempts:${team()}`,
      );
      await redis.del(`keyless_feedback_invitations:${team()}`);
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
      expect(fixture.refund).not.toHaveBeenCalled();
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
        schemaVersion: 1,
        answers: { origin: "mcp", integration: "cli" },
      });
      expect(rows[0].request_id).toBe(jobId);
      expect(rows[0].metadata).not.toHaveProperty("context");
      expect(JSON.stringify(rows)).not.toContain("job-private-content");
    },
  );
  it("accepts persisted jobs when invitation counters are missing", async () => {
    const { jobId } = await job("scrape");
    await redis.del(`keyless_feedback_invitations:${team()}`);
    expect((await submit(body("scrape", jobId))).status).toBe(200);
    expect(
      await redis.get(`keyless_feedback_context:${team()}:scrape:${jobId}`),
    ).toBeNull();
  });

  it("excludes validated Search lockdown jobs from feedback and invitations", async () => {
    const { searchRequestSchema } = await import("../types.js");
    const { jobId, metadata } = await job(
      "search",
      true,
      ip,
      searchRequestSchema.parse({
        query: "retry reference",
        scrapeOptions: { formats: ["markdown"], lockdown: true },
      }),
    );
    expect(metadata).toEqual({ jobId });
    expect(
      await redis.get(`keyless_feedback_invitations:${team()}`),
    ).toBeNull();
    expect((await submit(body("search", jobId))).status).toBe(404);
    expect(fixture.readResult).not.toHaveBeenCalled();
    const eligible = await job("search");
    expect((await submit(body("search", eligible.jobId))).status).toBe(200);
  });

  it("rejects unsupported nested Search zeroDataRetention before job execution", async () => {
    const { searchRequestSchema } = await import("../types.js");
    expect(
      searchRequestSchema.safeParse({
        query: "retry reference",
        scrapeOptions: { formats: ["markdown"], zeroDataRetention: true },
      }).success,
    ).toBe(false);
  });

  it("ignores caller invitation opt-out headers for keyless jobs", async () => {
    const jobId = randomUUID();
    const response = await request(app)
      .post(`/test/jobs/parse/${jobId}`)
      .set("x-firecrawl-no-feedback", "1")
      .send({});
    expect(response.body.metadata.jobId).toBe(jobId);
    expect(response.body.metadata.feedback).toBeDefined();
    expect(await redis.get(`keyless_feedback_invitations:${team()}`)).toBe("1");
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
      );
      expect(metadata).toEqual({ jobId: expect.any(String) });
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
    expect(fixture.readResult).not.toHaveBeenCalled();
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
  it("shares invitation frequency across categories and clients and suppresses invitations after acceptance", async () => {
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 3;
    const endpoints = ["search", "scrape", "parse"] as const;
    const clients = ["api", "mcp", "cli"] as const;
    const jobs: { endpoint: (typeof endpoints)[number]; jobId: string }[] = [];
    for (let index = 0; index < 6; index++) {
      const endpoint = endpoints[index % endpoints.length];
      const client = clients[index % clients.length];
      const jobId = randomUUID();
      const result = await request(app)
        .post(`/test/jobs/${endpoint}/${jobId}`)
        .send({ origin: client, integration: client });
      expect(result.status).toBe(200);
      expect(result.body.metadata.jobId).toBe(jobId);
      if ((index + 1) % 3 === 0) {
        expect(result.body.metadata.feedback).toMatchObject({
          endpoint,
          jobId,
        });
      } else {
        expect(result.body.metadata.feedback).toBeUndefined();
      }
      jobs.push({ endpoint, jobId });
    }
    expect(await redis.get(`keyless_feedback_invitations:${team()}`)).toBe("6");
    const accepted = jobs[2];
    expect((await submit(body(accepted.endpoint, accepted.jobId))).status).toBe(
      200,
    );
    for (const endpoint of endpoints) {
      expect((await job(endpoint)).metadata.feedback).toBeUndefined();
    }
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 0;
    expect((await job("parse")).metadata.feedback).toBeUndefined();
    expect(await redis.get(`keyless_feedback_invitations:${team()}`)).toBe("9");
  });
  it("bounds waiting when invitation counters are unavailable", async () => {
    const evaluate = vi
      .spyOn(redis, "eval")
      .mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    try {
      expect(
        await api.keylessFeedbackMetadata(
          {
            auth: { team_id: identity.keylessTeamId(ip) },
            body: {},
          } as any,
          "parse",
          randomUUID(),
          true,
        ),
      ).toEqual({ jobId: expect.any(String) });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      evaluate.mockRestore();
    }
  });
  it("keeps failed scrape jobs eligible without inviting or advancing cadence", async () => {
    const { jobId, metadata } = await job("scrape", false);
    expect(metadata).toEqual({ jobId });
    expect(
      await redis.get(`keyless_feedback_invitations:${team()}`),
    ).toBeNull();
    expect((await submit(body("scrape", jobId))).status).toBe(200);
    const [row] = await fixture.db!.select().from(table);
    expect(row.job_status).toBe("failed");
  });

  it("requires an explicit group for multi-source Search and persists valid reasons and verticals", async () => {
    const { jobId } = await job("search", true, ip, {
      sources: [{ type: "web" }, { type: "news" }],
    });
    const item = {
      kind: "irrelevant",
      position: 1,
      reason: "off_topic",
      vertical: "developer",
      basis: "output",
      detail: "The delivered result covers a different API.",
    };
    expect(
      (await submit({ ...body("search", jobId), observations: [item] })).status,
    ).toBe(400);
    expect(
      (
        await submit({
          ...body("search", jobId),
          observations: [{ ...item, source: "news" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await submit({
          ...body("search", jobId),
          observations: [
            { ...item, source: "web" },
            {
              kind: "missing",
              vertical: "research",
              basis: "expectation",
              detail: "The task needed a study of retry performance.",
            },
          ],
        })
      ).status,
    ).toBe(200);
    const [row] = await fixture.db!.select().from(table);
    expect(row.metadata).toMatchObject({
      answers: {
        observations: [expect.objectContaining(item), expect.anything()],
      },
    });
  });
  it("defaults omitted Search source to web and validates positions", async () => {
    const { jobId } = await job("search");
    const item = {
      kind: "useful",
      position: 1,
      basis: "output",
      detail: "The reference documents supported retry intervals.",
    };
    expect(
      (
        await submit({
          ...body("search", jobId),
          observations: [{ ...item, position: 2 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await submit({ ...body("search", jobId), observations: [item] })).status,
    ).toBe(200);
    const [row] = await fixture.db!.select().from(table);
    expect(row.metadata).toMatchObject({
      answers: { observations: [{ source: "web" }] },
    });
  });
  it.each(["images", "news"])(
    "keeps single-source %s positions in their delivered group",
    async source => {
      const { jobId } = await job("search", true, ip, { sources: [source] });
      fixture.results.set(jobId, {
        [source]: [{ title: "A result without a URL" }],
      });
      const item = {
        kind: "useful",
        position: 1,
        basis: "output",
        detail: "The first delivered result answered the retry question.",
      };
      expect(
        (await submit({ ...body("search", jobId), observations: [item] }))
          .status,
      ).toBe(400);
      expect(
        (
          await submit({
            ...body("search", jobId),
            observations: [{ ...item, source }],
          })
        ).status,
      ).toBe(200);
      const [row] = await fixture.db!.select().from(table);
      expect(row.metadata).toMatchObject({
        answers: { observations: [{ source, position: 1 }] },
      });
    },
  );
  it.each(["scrape", "parse"] as const)(
    "validates %s output formats against job options, including object formats",
    async endpoint => {
      const { jobId } = await job(endpoint, true, ip, {
        padding: "x".repeat(20000),
        formats: ["markdown", { type: "json", schema: { type: "object" } }],
      });
      const item = {
        kind: "incorrect",
        reason: "missing_fields",
        basis: "output",
        detail: "The returned object omits the documented retry interval.",
      };
      for (const format of [undefined, "html"])
        expect(
          (
            await submit({
              ...body(endpoint, jobId),
              observations: [{ ...item, format }],
            })
          ).status,
        ).toBe(400);
      expect(
        (
          await submit({
            ...body(endpoint, jobId),
            observations: [
              {
                ...item,
                basis: "source_comparison",
                comparison: {
                  reference: "Source retry section",
                  detail:
                    "The source contains the interval missing from output.",
                },
              },
            ],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await submit({
            ...body(endpoint, jobId),
            observations: [
              { ...item, format: "json" },
              { ...item, basis: "expectation" },
            ],
          })
        ).status,
      ).toBe(200);
      const [row] = await fixture.db!.select().from(table);
      expect(row.metadata).toMatchObject({
        answers: {
          observations: [
            expect.objectContaining({ ...item, format: "json" }),
            expect.anything(),
          ],
        },
      });
      if (endpoint === "parse")
        expect(row.metadata).toMatchObject({
          answers: { docClass: "unknown" },
        });
    },
  );
  it("accepts any requested format type and does not require format for single-format output", async () => {
    const { jobId } = await job("scrape", true, ip, {
      formats: [{ type: "links" }],
    });
    const item = {
      kind: "incomplete",
      reason: "pagination",
      basis: "output",
      detail: "The output only includes links from the first page.",
    };
    expect(
      (
        await submit({
          ...body("scrape", jobId),
          observations: [item, { ...item, format: "links" }],
        })
      ).status,
    ).toBe(200);
  });
  it("stores replacement sources for an irrelevant Search result", async () => {
    const { jobId } = await job("search");
    const observation = {
      kind: "irrelevant",
      position: 1,
      reason: "aggregator_over_official",
      knownSources: ["https://example.com/official"],
      basis: "output",
      detail: "The official reference should appear before the aggregator.",
    };
    expect(
      (await submit({ ...body("search", jobId), observations: [observation] }))
        .status,
    ).toBe(200);
    const [row] = await fixture.db!.select().from(table);
    expect(row.metadata).toMatchObject({
      answers: { observations: [{ ...observation, source: "web" }] },
    });
  });
  it.each([
    ["scrape", "markdown", "hallucinated", false],
    ["scrape", "summary", "missing_fields", false],
    ["scrape", "json", "missing_fields", true],
    ["scrape", "deterministicJson", "missing_fields", true],
    ["scrape", "json", "hallucinated", true],
    ["scrape", "deterministicJson", "hallucinated", true],
    ["scrape", "summary", "hallucinated", true],
    ["scrape", "question", "hallucinated", true],
    ["scrape", "highlights", "hallucinated", true],
    [
      "scrape",
      { type: "changeTracking", modes: ["json"] },
      "hallucinated",
      true,
    ],
    [
      "scrape",
      { type: "changeTracking", modes: ["git-diff"] },
      "hallucinated",
      false,
    ],
    ["scrape", "markdown", "wrong", true],
    ["parse", "markdown", "wrong", false],
    ["parse", "json", "missing_fields", true],
    ["parse", "summary", "hallucinated", true],
  ] as const)(
    "checks %s incorrect reason compatibility: %j / %s",
    async (endpoint, format, reason, accepted) => {
      const { jobId } = await job(endpoint, true, ip, {
        padding: "x".repeat(20000),
        formats: [format],
      });
      const observation = {
        kind: "incorrect",
        reason,
        basis: "output",
        detail: "The returned output does not match the expected information.",
      };
      expect(
        (
          await submit({
            ...body(endpoint, jobId),
            observations: [observation],
          })
        ).status,
      ).toBe(accepted ? 200 : 400);
    },
  );
  it("does not load or copy Parse document content", async () => {
    const { jobId } = await job("parse");
    fixture.results.set(jobId, { markdown: "document-private-content" });
    expect((await submit(body("parse", jobId))).status).toBe(200);
    expect(fixture.readResult).not.toHaveBeenCalled();
    const [row] = await fixture.db!.select().from(table);
    expect(row.metadata).not.toHaveProperty("context");
    expect(JSON.stringify(row.metadata)).not.toContain(
      "document-private-content",
    );
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
      await redis.del(`keyless_feedback_invitations:${otherIdentity}`);
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
  it("uses the persisted job timestamp for the feedback window", async () => {
    const { jobId } = await job("scrape");
    await fixture.pool!.query(
      "UPDATE scrapes SET created_at = now() - interval '24 hours 1 second' WHERE id = $1",
      [jobId],
    );
    expect((await submit(body("scrape", jobId))).body.feedbackErrorCode).toBe(
      "FEEDBACK_WINDOW_EXPIRED",
    );
    expect(await fixture.db!.select().from(table)).toHaveLength(0);
  });
  it.each(["search", "scrape", "parse"] as const)(
    "excludes zero-retention %s jobs",
    async endpoint => {
      const options =
        endpoint === "search"
          ? { enterprise: ["zdr"] }
          : { zeroDataRetention: true };
      const { jobId, metadata } = await job(endpoint, true, ip, options);
      expect(metadata).toEqual({ jobId });
      expect((await submit(body(endpoint, jobId))).status).toBe(404);
      expect(fixture.readResult).not.toHaveBeenCalled();
      expect(await fixture.db!.select().from(table)).toHaveLength(0);
    },
  );
  it("retries a job that becomes visible after the first lookup", async () => {
    const jobId = randomUUID();
    const pending = submit(body("scrape", jobId)).then(response => response);
    await new Promise(resolve => setTimeout(resolve, 100));
    await persistJob("scrape", jobId);
    expect((await pending).status).toBe(200);
  });
  it("does not use the daily slot for a missing job", async () => {
    expect((await submit(body("scrape", randomUUID()))).status).toBe(404);
    const { jobId } = await job("scrape");
    expect((await submit(body("scrape", jobId))).status).toBe(200);
  });
  it("keeps Search feedback retryable until its existing result is available", async () => {
    const { jobId } = await job("search");
    const results = fixture.results.get(jobId);
    fixture.results.delete(jobId);
    const unavailable = await submit(body("search", jobId));
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.feedbackErrorCode).toBe("FEEDBACK_UNAVAILABLE");
    expect(await fixture.db!.select().from(table)).toHaveLength(0);
    fixture.results.set(jobId, results);
    expect((await submit(body("search", jobId))).status).toBe(200);
  });
  it("does not load Search results for missing-content observations", async () => {
    const { jobId } = await job("search");
    fixture.results.delete(jobId);
    expect(
      (
        await submit({
          ...body("search", jobId),
          observations: [
            {
              kind: "missing",
              vertical: "developer",
              basis: "expectation",
              detail: "The task needed a reference on retry intervals.",
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(fixture.readResult).not.toHaveBeenCalled();
  });
  it("validates positions against each delivered group", async () => {
    const { jobId } = await job("search", true, ip, {
      sources: ["web", "news"],
    });
    fixture.results.set(jobId, {
      web: [{ url: "https://example.com/web" }],
      news: [
        { url: "https://example.com/first" },
        { url: "https://example.com/second" },
      ],
    });
    const payload = body("search", jobId);
    (payload.observations[0] as any).position = 2;
    expect((await submit(payload)).status).toBe(400);
    (payload.observations[0] as any).source = "news";
    expect((await submit(payload)).status).toBe(200);
    expect(fixture.readResult).toHaveBeenCalledWith(jobId);
  });
  it.each(["generic", "legacy"] as const)(
    "preserves authenticated %s Search feedback and refunds",
    async route => {
      const { jobId } = await job("search");
      await fixture.pool!.query(
        "UPDATE searches SET team_id = $1, credits_cost = 4 WHERE id = $2",
        [authenticatedTeam, jobId],
      );
      config.KEYLESS_FEEDBACK_ENABLED = false;
      try {
        const path =
          route === "generic"
            ? "/test/authenticated/feedback"
            : `/test/authenticated/search/${jobId}/feedback`;
        const payload = {
          ...(route === "generic" ? { endpoint: "search", jobId } : {}),
          rating: "bad",
          querySuggestions: "Search for the official retry documentation.",
        };
        const accepted = await request(app).post(path).send(payload);
        expect(accepted.status).toBe(200);
        expect(accepted.body.creditsRefunded).toBe(1);
        expect(fixture.refund).toHaveBeenCalledWith(
          expect.objectContaining({
            teamId: authenticatedTeam,
            orgId,
            value: 1,
          }),
        );
        const duplicate = await request(app).post(path).send(payload);
        expect(duplicate.status).toBe(200);
        expect(duplicate.body.alreadySubmitted).toBe(true);
        expect(duplicate.body.feedbackId).toBe(accepted.body.feedbackId);
        expect(fixture.refund).toHaveBeenCalledTimes(1);
        expect(fixture.readResult).not.toHaveBeenCalled();
        const [row] = await fixture.db!.select().from(table);
        expect(row).toMatchObject({
          request_id: jobId,
          team_id: authenticatedTeam,
          credits_refunded: 1,
        });
      } finally {
        config.KEYLESS_FEEDBACK_ENABLED = true;
      }
    },
  );
  it("preserves authenticated Search failure and age restrictions", async () => {
    const { jobId } = await job("search", false);
    await fixture.pool!.query(
      "UPDATE searches SET team_id = $1 WHERE id = $2",
      [authenticatedTeam, jobId],
    );
    const payload = {
      endpoint: "search",
      jobId,
      rating: "bad",
      querySuggestions: "Search for the official retry documentation.",
    };
    const failed = await request(app)
      .post("/test/authenticated/feedback")
      .send(payload);
    expect(failed.status).toBe(409);
    expect(failed.body.feedbackErrorCode).toBe("SEARCH_FAILED");
    await fixture.pool!.query(
      "UPDATE searches SET is_successful = true, created_at = now() - interval '10 minutes' WHERE id = $1",
      [jobId],
    );
    const expired = await request(app)
      .post("/test/authenticated/feedback")
      .send(payload);
    expect(expired.status).toBe(409);
    expect(fixture.refund).not.toHaveBeenCalled();
    expect(await fixture.db!.select().from(table)).toHaveLength(0);
  });
  it.each(["scrape", "parse"] as const)(
    "preserves authenticated %s refunds independently of keyless limits",
    async endpoint => {
      const { jobId } = await job(endpoint);
      const name = endpoint === "scrape" ? "scrapes" : "parses";
      await fixture.pool!.query(
        `UPDATE ${name} SET team_id = $1, credits_cost = 8 WHERE id = $2`,
        [authenticatedTeam, jobId],
      );
      const payload = {
        endpoint,
        jobId,
        rating: "bad",
        note: "The output omitted the requested retry intervals.",
      };
      const accepted = await request(app)
        .post("/test/authenticated/feedback")
        .send(payload);
      expect(accepted.status).toBe(200);
      expect(accepted.body.creditsRefunded).toBe(endpoint === "parse" ? 2 : 1);
      expect(fixture.refund).toHaveBeenCalledTimes(1);
      expect(fixture.readResult).not.toHaveBeenCalled();
      const keyless = await job(endpoint);
      expect((await submit(body(endpoint, keyless.jobId))).status).toBe(200);
      expect(fixture.refund).toHaveBeenCalledTimes(1);
    },
  );
});
