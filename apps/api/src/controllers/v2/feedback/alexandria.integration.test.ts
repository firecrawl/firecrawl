import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const fixture = vi.hoisted(() => ({
  db: undefined as ReturnType<typeof drizzle> | undefined,
}));
vi.mock("../../../db/connection", () => ({ db: fixture.db }));
vi.mock("./record", () => ({
  recordEndpointFeedback: () => {
    throw new Error("Alexandria must not enter the job/refund path");
  },
}));

// Opt in with a local database containing the feedback migrations, including
// the Alexandria endpoint constraint. Each run owns an isolated schema.
const databaseUrl = process.env.ALEXANDRIA_FEEDBACK_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("Alexandria feedback HTTP and PostgreSQL persistence", () => {
  const schemaName = `alexandria_feedback_${randomUUID().replaceAll("-", "")}`;
  const teamId = randomUUID();
  let pool: Pool;
  let admin: Pool;
  let app: express.Express;
  let config: typeof import("../../../config").config;
  let originalAuthentication: boolean | undefined;
  const minimal = {
    categories: ["alexandria"],
    rating: "bad",
    requestedWebsite: "https://sam.gov",
    requestedVertical: "government",
  };
  const submit = (body: object) => request(app).post("/v2/feedback").send(body);

  beforeAll(async () => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(databaseUrl!).hostname,
      )
    ) {
      throw new Error("Alexandria integration tests require a local database");
    }
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
    });
    await pool.query(
      "CREATE TABLE search_feedback (LIKE public.search_feedback INCLUDING ALL)",
    );
    fixture.db = drizzle({ client: pool });
    config = (await import("../../../config.js")).config;
    originalAuthentication = config.USE_DB_AUTHENTICATION;
    config.USE_DB_AUTHENTICATION = true;
    const { feedbackController } = await import("./controller.js");
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        auth: { team_id: teamId },
        acuc: { flags: {}, api_key_id: 42 },
      });
      next();
    });
    app.post("/v2/feedback", feedbackController as any);
  });

  afterAll(async () => {
    if (config) config.USE_DB_AUTHENTICATION = originalAuthentication;
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await admin.end();
    }
  });

  it("persists the minimum payload and independent sessions without inventing job IDs", async () => {
    const first = await submit(minimal);
    const second = await submit(minimal);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.feedbackId).not.toBe(first.body.feedbackId);
    const { rows } = await pool.query(
      "SELECT * FROM search_feedback WHERE team_id = $1",
      [teamId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        endpoint: "alexandria",
        team_id: teamId,
        overall_rating: "bad",
        job_id: null,
        search_id: null,
        request_id: null,
        job_status: null,
        credits_refunded: 0,
        credits_billed: 0,
        refund_policy: null,
        metadata: {
          schemaVersion: 1,
          categories: ["alexandria"],
          requestedWebsite: "https://sam.gov",
          requestedVertical: "government",
        },
      });
    }
  });

  it("round-trips structured observations", async () => {
    const search = [
      {
        kind: "missing",
        vertical: "government",
        basis: "expectation",
        detail: "Expected access to contract attachments.",
      },
    ];
    const scrape = [
      {
        kind: "incomplete",
        reason: "pagination",
        basis: "output",
        detail: "Only the first page of contracts was returned.",
      },
    ];
    const response = await submit({ ...minimal, search, scrape });
    expect(response.status).toBe(200);
    const { rows } = await pool.query(
      "SELECT metadata FROM search_feedback WHERE id = $1",
      [response.body.feedbackId],
    );
    expect(rows[0].metadata).toMatchObject({ search, scrape });
  });

  it("rejects invalid feedback before persistence", async () => {
    const before = await pool.query("SELECT count(*) FROM search_feedback");
    const response = await submit({
      ...minimal,
      requestedVertical: "unrecognized",
    });
    expect(response.status).toBe(400);
    const after = await pool.query("SELECT count(*) FROM search_feedback");
    expect(after.rows).toEqual(before.rows);
  });
});
