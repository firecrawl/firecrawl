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

// Opt in with a local PostgreSQL database. Each run owns an isolated schema
// holding a copy of the Alexandria feedback tables, including constraints.
const databaseUrl = process.env.ALEXANDRIA_FEEDBACK_TEST_DATABASE_URL;
const ddl = `
CREATE TABLE alexandria_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  team_id uuid NOT NULL,
  api_key_id bigint,
  api_version text NOT NULL DEFAULT 'v2',
  rating text NOT NULL CHECK (rating IN ('good', 'partial', 'bad')),
  requested_url text NOT NULL CHECK (char_length(requested_url) <= 2048),
  requested_host text GENERATED ALWAYS AS (lower(substring(requested_url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/?#:]+)'))) STORED,
  requested_functionality text NOT NULL,
  rationale text NOT NULL,
  origin text,
  integration text,
  schema_version integer NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alexandria_feedback_providers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feedback_id uuid NOT NULL REFERENCES alexandria_feedback (id) ON DELETE CASCADE,
  team_id uuid NOT NULL,
  position smallint NOT NULL,
  name text NOT NULL,
  issue text NOT NULL CHECK (issue IN ('missing_provider', 'insufficient_coverage', 'provider_unavailable', 'other')),
  why text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feedback_id, position)
);
CREATE TABLE alexandria_feedback_capabilities (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feedback_id uuid NOT NULL REFERENCES alexandria_feedback (id) ON DELETE CASCADE,
  team_id uuid NOT NULL,
  position smallint NOT NULL,
  name text NOT NULL,
  provider text NOT NULL,
  issue text NOT NULL CHECK (issue IN ('new_capability_request', 'missing_capability', 'insufficient_functionality', 'incorrect_result', 'execution_error', 'other')),
  why text NOT NULL,
  requested_functionality text CHECK (issue <> 'new_capability_request' OR requested_functionality IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feedback_id, position)
);
`;
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
    endpoint: "alexandria",
    rating: "bad",
    requestedWebsite: {
      url: "https://sam.gov",
      requestedFunctionality:
        "Find active contracts by agency and export their attachments as CSV.",
    },
    rationale: "Found contract summaries but could not retrieve attachments.",
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
    await pool.query(ddl);
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
      "SELECT * FROM alexandria_feedback WHERE team_id = $1",
      [teamId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        team_id: teamId,
        api_key_id: "42",
        api_version: "v2",
        rating: "bad",
        requested_url: minimal.requestedWebsite.url,
        requested_host: "sam.gov",
        requested_functionality:
          minimal.requestedWebsite.requestedFunctionality,
        rationale: minimal.rationale,
        origin: "api",
        integration: null,
        schema_version: 2,
      });
    }
    const children = await pool.query(
      "SELECT (SELECT count(*) FROM alexandria_feedback_providers) AS providers, (SELECT count(*) FROM alexandria_feedback_capabilities) AS capabilities",
    );
    expect(children.rows[0]).toEqual({ providers: "0", capabilities: "0" });
  });

  it("round-trips provider and capability feedback into ordered child rows", async () => {
    const providerFeedback = [
      {
        name: "sam.gov",
        issue: "insufficient_coverage",
        why: "The provider only returned contract summaries.",
      },
    ];
    const capabilityFeedback = [
      {
        name: "download-attachments",
        provider: "sam.gov",
        issue: "new_capability_request",
        why: "Need the source documents to compare contract requirements.",
        requestedFunctionality:
          "Given a contract ID, return all attachment URLs and document text.",
      },
      {
        name: "contracts",
        provider: "sam.gov",
        issue: "missing_capability",
        why: "The provider has no contract attachment capability.",
      },
      {
        name: "contracts",
        provider: "sam.gov",
        issue: "execution_error",
        why: "The second page request timed out.",
      },
    ];
    const response = await submit({
      ...minimal,
      providerFeedback,
      capabilityFeedback,
      integration: "cli",
    });
    expect(response.status).toBe(200);
    const feedbackId = response.body.feedbackId;
    const parent = await pool.query(
      "SELECT rating, rationale, integration FROM alexandria_feedback WHERE id = $1",
      [feedbackId],
    );
    expect(parent.rows).toEqual([
      {
        rating: minimal.rating,
        rationale: minimal.rationale,
        integration: "cli",
      },
    ]);
    const providers = await pool.query(
      "SELECT team_id, position, name, issue, why FROM alexandria_feedback_providers WHERE feedback_id = $1 ORDER BY position",
      [feedbackId],
    );
    expect(providers.rows).toEqual(
      providerFeedback.map((entry, position) => ({
        team_id: teamId,
        position,
        ...entry,
      })),
    );
    const capabilities = await pool.query(
      "SELECT team_id, position, name, provider, issue, why, requested_functionality FROM alexandria_feedback_capabilities WHERE feedback_id = $1 ORDER BY position",
      [feedbackId],
    );
    expect(capabilities.rows).toEqual(
      capabilityFeedback.map(
        ({ requestedFunctionality, ...entry }, position) => ({
          team_id: teamId,
          position,
          requested_functionality: requestedFunctionality ?? null,
          ...entry,
        }),
      ),
    );
  });

  it("rejects invalid feedback before persistence", async () => {
    const before = await pool.query("SELECT count(*) FROM alexandria_feedback");
    const response = await submit({
      ...minimal,
      capabilityFeedback: [
        {
          name: "download-attachments",
          provider: "sam.gov",
          issue: "new_capability_request",
          why: "Need access to contract attachments.",
        },
      ],
    });
    expect(response.status).toBe(400);
    const after = await pool.query("SELECT count(*) FROM alexandria_feedback");
    expect(after.rows).toEqual(before.rows);
  });

  it("deletes child rows with their parent", async () => {
    const response = await submit({
      ...minimal,
      providerFeedback: [
        { name: "sam.gov", issue: "other", why: "Slow responses." },
      ],
    });
    expect(response.status).toBe(200);
    await pool.query("DELETE FROM alexandria_feedback WHERE id = $1", [
      response.body.feedbackId,
    ]);
    const orphans = await pool.query(
      "SELECT count(*) FROM alexandria_feedback_providers WHERE feedback_id = $1",
      [response.body.feedbackId],
    );
    expect(orphans.rows[0].count).toBe("0");
  });
});
