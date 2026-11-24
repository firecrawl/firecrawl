import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  values: vi.fn(),
  set: vi.fn(),
  returning: vi.fn(),
  getBrowserSession: vi.fn(),
  getBrowserSessionFromScrape: vi.fn(),
  readFeedbackJob: vi.fn(),
  refund: vi.fn(),
  existingScrapeFeedbackId: "01933161-0000-7000-8000-0000000000aa",
}));
// The store runs for real against this client, so the tests see the rows it
// writes: insert().values(row) and update().set(row).where().returning().
vi.mock("../../../db/connection", () => ({
  db: {
    insert: () => ({ values: mocks.values }),
    update: () => ({
      set: (row: unknown) => {
        mocks.set(row);
        return { where: () => ({ returning: mocks.returning }) };
      },
    }),
  },
  dbRr: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { id: mocks.existingScrapeFeedbackId, credits_refunded: 1 },
          ],
        }),
      }),
    }),
  },
}));
vi.mock("../../../lib/browser-sessions", () => ({
  getBrowserSession: mocks.getBrowserSession,
  getBrowserSessionFromScrape: mocks.getBrowserSessionFromScrape,
}));
vi.mock("../../../lib/feedback-job-store", () => ({
  readFeedbackJob: mocks.readFeedbackJob,
}));
vi.mock("./refund-totals", () => ({
  sumCreditsRefundedToday: async () => 0,
}));
vi.mock("../../../lib/alexandria-activity", () => ({
  hasRecentAlexandriaActivity: async () => false,
  getRecentAlexandriaCalls: async () => [],
}));
vi.mock("./alexandria-refund", () => ({
  refundAlexandriaFeedback: async () => ({ creditsRefunded: 0 }),
}));
vi.mock("../../../services/autumn/autumn.service", () => ({
  SEARCH_CREDITS_FEATURE_ID: "SEARCH_CREDITS",
  featureIdForBillingEndpoint: (endpoint: string) =>
    endpoint === "search" ? "SEARCH_CREDITS" : "CREDITS",
  autumnService: { refundCredits: mocks.refund },
}));

import { config } from "../../../config";
import { feedbackEnv } from "../../../lib/feedback-env";
import { feedbackController } from "./controller";

const original = { ...config };
const originalFeedbackEnv = { ...feedbackEnv };
const teamId = "01933161-0000-7000-8000-000000000001";
const otherTeamId = "01933161-0000-7000-8000-000000000002";
const scrapeId = "01933161-0000-7000-8000-000000000003";
const sessionId = "01933161-0000-7000-8000-000000000004";
const requestId = "01933161-0000-7000-8000-000000000005";
const storedFeedbackId = "01933161-0000-7000-8000-000000000006";
const zeroId = "00000000-0000-0000-0000-000000000000";
const uniqueViolation = Object.assign(
  new Error(
    'duplicate key value violates unique constraint "search_feedback_once_per_job_idx"',
  ),
  { code: "23505" },
);

type SessionEndpoint = "interact" | "browser";
const endpoints: SessionEndpoint[] = ["interact", "browser"];
const jobIdOf = (endpoint: SessionEndpoint) =>
  endpoint === "interact" ? scrapeId : sessionId;
const lookupOf = (endpoint: SessionEndpoint) =>
  endpoint === "interact"
    ? mocks.getBrowserSessionFromScrape
    : mocks.getBrowserSession;

let authTeam: string;
let flags: Record<string, unknown>;
let hostedMcp: boolean;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: authTeam, ...(hostedMcp ? { hostedMcp: true } : {}) },
    acuc: { flags, org_id: "org-1", api_key_id: 42 },
  });
  next();
});
app.post("/v2/feedback", feedbackController as any);

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    team_id: teamId,
    request_id: requestId,
    scrape_id: scrapeId,
    zero_data_retention: false,
    status: "active",
    ttl_total: 3600,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function haveSession(
  endpoint: SessionEndpoint,
  overrides?: Record<string, unknown>,
) {
  lookupOf(endpoint).mockResolvedValue(session(overrides));
}

const submit = (
  endpoint: SessionEndpoint | "scrape",
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  request(app)
    .post("/v2/feedback")
    .set(headers)
    .send({
      endpoint,
      jobId: endpoint === "browser" ? sessionId : scrapeId,
      rating: "partial",
      note: "The form never finished loading.",
      ...body,
    });

const insertedRow = () => mocks.values.mock.calls[0]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(config, original, {
    USE_DB_AUTHENTICATION: true,
  });
  Object.assign(feedbackEnv, originalFeedbackEnv, {
    FEEDBACK_REFUND_ENABLED: true,
    FEEDBACK_MAX_AGE_SEC: 120,
    BROWSER_FEEDBACK_MAX_AGE_SEC: 3600,
  });
  authTeam = teamId;
  flags = {};
  hostedMcp = false;
  mocks.values.mockResolvedValue(undefined);
  mocks.returning.mockResolvedValue([]);
  mocks.getBrowserSession.mockResolvedValue(null);
  mocks.getBrowserSessionFromScrape.mockResolvedValue(null);
  mocks.readFeedbackJob.mockResolvedValue(null);
});
afterAll(() => {
  Object.assign(config, original);
  Object.assign(feedbackEnv, originalFeedbackEnv);
});

describe("feedback for interact and browser sessions", () => {
  it("stores interact feedback under the scrape job, with the session it ran in", async () => {
    haveSession("interact");

    const response = await submit("interact", { metadata: { step: "login" } });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ success: true, creditsRefunded: 0 });
    expect(response.body.alreadySubmitted).toBeUndefined();
    expect(mocks.getBrowserSessionFromScrape).toHaveBeenCalledWith(scrapeId);
    expect(mocks.getBrowserSession).not.toHaveBeenCalled();
    expect(mocks.values).toHaveBeenCalledTimes(1);
    expect(insertedRow()).toMatchObject({
      id: response.body.feedbackId,
      search_id: null,
      endpoint: "interact",
      job_id: scrapeId,
      request_id: requestId,
      team_id: teamId,
      api_key_id: 42,
      overall_rating: "partial",
      comment: "The form never finished loading.",
      metadata: { step: "login", browserSessionId: sessionId },
      credits_billed: 0,
      credits_refunded: 0,
    });
  });

  it("does not let the caller name another session in the metadata", async () => {
    haveSession("interact");

    await submit("interact", { metadata: { browserSessionId: "spoofed" } });

    expect(insertedRow().metadata).toEqual({ browserSessionId: sessionId });
  });

  it("stores browser feedback under the session id", async () => {
    haveSession("browser");

    const response = await submit("browser");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ success: true, creditsRefunded: 0 });
    expect(mocks.getBrowserSession).toHaveBeenCalledWith(sessionId);
    expect(mocks.getBrowserSessionFromScrape).not.toHaveBeenCalled();
    expect(insertedRow()).toMatchObject({
      id: response.body.feedbackId,
      endpoint: "browser",
      job_id: sessionId,
      request_id: requestId,
      team_id: teamId,
      credits_billed: 0,
      credits_refunded: 0,
    });
    expect(insertedRow().metadata).toEqual({});
  });

  it.each(endpoints)(
    "never refunds %s feedback and reads no feedback job",
    async endpoint => {
      haveSession(endpoint);

      for (const rating of ["good", "partial", "bad"]) {
        const response = await submit(endpoint, { rating });
        expect(response.body).toMatchObject({
          success: true,
          creditsRefunded: 0,
        });
      }

      expect(mocks.refund).not.toHaveBeenCalled();
      expect(mocks.readFeedbackJob).not.toHaveBeenCalled();
      // The refund details written after each insert.
      expect(mocks.set).toHaveBeenCalledTimes(3);
      for (const [details] of mocks.set.mock.calls) {
        expect(details).toMatchObject({
          credits_refunded: 0,
          refund_policy: {
            endpoint,
            mode: "none",
            matchedReason: "zero_billed_credits",
          },
        });
      }
    },
  );

  it.each(endpoints)(
    "answers 404 for %s feedback when there is no session",
    async endpoint => {
      const response = await submit(endpoint);

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        success: false,
        feedbackErrorCode: "JOB_NOT_FOUND",
        error: `${endpoint} job not found for this team.`,
      });
      expect(lookupOf(endpoint)).toHaveBeenCalledTimes(1);
      expect(mocks.values).not.toHaveBeenCalled();
    },
  );

  it.each(endpoints)(
    "answers 404 for %s feedback on another team's session",
    async endpoint => {
      haveSession(endpoint, { team_id: otherTeamId });

      const response = await submit(endpoint);

      expect(response.status).toBe(404);
      expect(response.body.feedbackErrorCode).toBe("JOB_NOT_FOUND");
      expect(mocks.values).not.toHaveBeenCalled();
    },
  );

  it.each(endpoints)(
    "measures the %s window from the session's last activity",
    async endpoint => {
      // Opened half an hour ago, used ten minutes ago: past the job window,
      // inside the session window.
      haveSession(endpoint, {
        created_at: new Date(Date.now() - 1800 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 600 * 1000).toISOString(),
      });
      expect((await submit(endpoint)).status).toBe(200);

      haveSession(endpoint, {
        created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 3660 * 1000).toISOString(),
      });
      const expired = await submit(endpoint);
      expect(expired.status).toBe(409);
      expect(expired.body).toMatchObject({
        success: false,
        feedbackErrorCode: "FEEDBACK_WINDOW_EXPIRED",
        error:
          "Feedback must be submitted within 3600 seconds of the session's last activity.",
      });
      expect(mocks.values).toHaveBeenCalledTimes(1);
    },
  );

  it.each(endpoints)(
    "does not reopen the %s window when the session is settled late",
    async endpoint => {
      // Lived ten minutes, three hours ago, and was settled just now.
      haveSession(endpoint, {
        created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
        ttl_total: 600,
        updated_at: new Date().toISOString(),
      });
      const expired = await submit(endpoint);
      expect(expired.status).toBe(409);
      expect(expired.body.feedbackErrorCode).toBe("FEEDBACK_WINDOW_EXPIRED");

      // Ended ten minutes ago and was settled just now: still in the window.
      haveSession(endpoint, {
        created_at: new Date(Date.now() - 1200 * 1000).toISOString(),
        ttl_total: 600,
        updated_at: new Date().toISOString(),
      });
      expect((await submit(endpoint)).status).toBe(200);
    },
  );

  it.each(endpoints)(
    "reads the %s window from BROWSER_FEEDBACK_MAX_AGE_SEC",
    async endpoint => {
      feedbackEnv.BROWSER_FEEDBACK_MAX_AGE_SEC = 60;
      haveSession(endpoint, {
        updated_at: new Date(Date.now() - 90 * 1000).toISOString(),
      });

      const response = await submit(endpoint);

      expect(response.status).toBe(409);
      expect(response.body.feedbackErrorCode).toBe("FEEDBACK_WINDOW_EXPIRED");
    },
  );

  it.each(endpoints)("refuses %s feedback from an opted-out team", async e => {
    haveSession(e);
    flags = { searchFeedbackOptOut: true };

    const response = await submit(e);

    expect(response.status).toBe(403);
    expect(response.body.feedbackErrorCode).toBe("TEAM_OPTED_OUT");
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it.each(endpoints)("refuses %s feedback from a preview team", async e => {
    haveSession(e);
    authTeam = "preview_abc";

    const response = await submit(e);

    expect(response.status).toBe(403);
    expect(response.body.feedbackErrorCode).toBe("PREVIEW_TEAM_NOT_ALLOWED");
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it.each(endpoints)(
    "answers 503 for %s feedback without database authentication",
    async endpoint => {
      haveSession(endpoint);
      config.USE_DB_AUTHENTICATION = false;

      const response = await submit(endpoint);

      expect(response.status).toBe(503);
      expect(response.body.feedbackErrorCode).toBe("DB_DISABLED");
      expect(mocks.values).not.toHaveBeenCalled();
    },
  );

  it.each(
    endpoints.flatMap(endpoint =>
      [{ scrapeZDR: "forced" }, { forceZDR: true }].map(
        teamFlags => [endpoint, teamFlags] as const,
      ),
    ),
  )(
    "accepts %s feedback from a team with %j and stores nothing",
    async (endpoint, teamFlags) => {
      haveSession(endpoint);
      flags = teamFlags;

      const response = await submit(endpoint);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        feedbackId: zeroId,
        creditsRefunded: 0,
      });
      expect(lookupOf(endpoint)).not.toHaveBeenCalled();
      expect(mocks.values).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
    },
  );

  it.each(endpoints)(
    "stores %s feedback from a team where zero data retention is optional",
    async endpoint => {
      haveSession(endpoint);
      flags = { scrapeZDR: "allowed" };

      const response = await submit(endpoint);

      expect(response.status).toBe(200);
      expect(response.body.feedbackId).not.toBe(zeroId);
      expect(mocks.values).toHaveBeenCalledTimes(1);
    },
  );

  it.each(endpoints)(
    "accepts %s feedback on a zero data retention session and stores nothing",
    async endpoint => {
      haveSession(endpoint, { zero_data_retention: true });

      const response = await submit(endpoint);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        feedbackId: zeroId,
        creditsRefunded: 0,
      });
      expect(mocks.values).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
    },
  );

  it.each(endpoints)(
    "overwrites the stored row when a %s session is rated again",
    async endpoint => {
      haveSession(endpoint);
      mocks.values.mockRejectedValueOnce(uniqueViolation);
      mocks.returning.mockResolvedValueOnce([{ id: storedFeedbackId }]);

      const response = await submit(endpoint, {
        rating: "bad",
        note: "It broke on the second page.",
        issues: ["navigation_failed"],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        feedbackId: storedFeedbackId,
        creditsRefunded: 0,
      });
      expect(response.body.alreadySubmitted).toBeUndefined();
      expect(mocks.set).toHaveBeenCalledTimes(1);
      const replaced = mocks.set.mock.calls[0][0];
      expect(replaced).toMatchObject({
        overall_rating: "bad",
        issue_types: ["navigation_failed"],
        tags: [],
        comment: "It broke on the second page.",
        valuable_sources: [],
        missing_content: [],
        query_suggestions: null,
        origin: "api",
        integration: null,
        external_request_id: null,
        session_id: null,
        session_source: null,
        thread_id: null,
        thread_source: null,
        objective: null,
        updated_at: expect.any(String),
      });
      expect(replaced.metadata).toEqual(
        endpoint === "interact" ? { browserSessionId: sessionId } : {},
      );
      // The row keeps its identity, its billing and its refund record.
      for (const kept of [
        "id",
        "team_id",
        "endpoint",
        "job_id",
        "credits_billed",
        "credits_refunded",
        "refund_policy",
        "created_at",
      ]) {
        expect(replaced).not.toHaveProperty(kept);
      }
      expect(mocks.refund).not.toHaveBeenCalled();
    },
  );

  it("answers 500 when the row to overwrite is gone", async () => {
    haveSession("browser");
    mocks.values.mockRejectedValueOnce(uniqueViolation);

    const response = await submit("browser");

    expect(response.status).toBe(500);
    expect(response.body.feedbackErrorCode).toBe("INTERNAL");
  });

  it("still answers a second scrape rating with alreadySubmitted", async () => {
    mocks.readFeedbackJob.mockResolvedValue({
      requestId,
      teamId,
      refundClass: "scrape_basic",
      feedbackDeadlineMs: Date.now() + 60_000,
      succeeded: true,
      creditsBilled: 1,
      zeroDataRetention: false,
    });
    mocks.values.mockRejectedValueOnce(uniqueViolation);

    const response = await submit("scrape");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      alreadySubmitted: true,
      feedbackId: mocks.existingScrapeFeedbackId,
      creditsRefunded: 0,
    });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});

describe("trace ids on stored feedback rows", () => {
  const lineage = {
    session_id: "sess_01HZX",
    session_source: "token",
    thread_id: "thread:42",
    thread_source: "client",
    objective: "Book a table for two.",
  };
  const headers = {
    "External-Request-Id": "0190a5d4-7b10-7cc3-98c4-0242ac120002",
    "X-Firecrawl-Mcp-Lineage": Buffer.from(JSON.stringify(lineage)).toString(
      "base64url",
    ),
  };
  const scrapeJob = {
    requestId,
    teamId,
    refundClass: "scrape_basic",
    feedbackDeadlineMs: Date.now() + 60_000,
    succeeded: true,
    creditsBilled: 1,
    zeroDataRetention: false,
  };

  it("stores the request id and the lineage of a hosted MCP call on a scrape row", async () => {
    mocks.readFeedbackJob.mockResolvedValue(scrapeJob);
    hostedMcp = true;

    const response = await submit("scrape", {}, headers);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(insertedRow()).toMatchObject({
      endpoint: "scrape",
      external_request_id: "0190a5d4-7b10-7cc3-98c4-0242ac120002",
      ...lineage,
    });
  });

  it("stores them on an interact row", async () => {
    haveSession("interact");
    hostedMcp = true;

    await submit("interact", {}, headers);

    expect(insertedRow()).toMatchObject({
      endpoint: "interact",
      external_request_id: "0190a5d4-7b10-7cc3-98c4-0242ac120002",
      ...lineage,
    });
  });

  it("stores only the request id for a caller that is not the hosted MCP server", async () => {
    mocks.readFeedbackJob.mockResolvedValue(scrapeJob);

    await submit("scrape", {}, headers);

    expect(insertedRow()).toMatchObject({
      external_request_id: "0190a5d4-7b10-7cc3-98c4-0242ac120002",
      session_id: null,
      session_source: null,
      thread_id: null,
      thread_source: null,
      objective: null,
    });
  });

  it("stores the feedback when the lineage header is unreadable", async () => {
    mocks.readFeedbackJob.mockResolvedValue(scrapeJob);
    hostedMcp = true;

    const response = await submit(
      "scrape",
      {},
      { "X-Firecrawl-Mcp-Lineage": "%%%not-base64%%%" },
    );

    expect(response.status).toBe(200);
    expect(insertedRow()).toMatchObject({
      external_request_id: null,
      session_id: null,
      thread_id: null,
      objective: null,
    });
  });

  it("writes the lineage of the newer call when a session is rated again", async () => {
    haveSession("browser");
    hostedMcp = true;
    mocks.values.mockRejectedValueOnce(uniqueViolation);
    mocks.returning.mockResolvedValueOnce([{ id: storedFeedbackId }]);

    await submit("browser", {}, headers);

    expect(mocks.set.mock.calls[0][0]).toMatchObject({
      external_request_id: "0190a5d4-7b10-7cc3-98c4-0242ac120002",
      ...lineage,
    });
  });
});
