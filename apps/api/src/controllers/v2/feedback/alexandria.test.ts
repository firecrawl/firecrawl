import express from "express";
import request from "supertest";
import { getTableName, type Table } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { alexandriaFeedbackSchema } from "./alexandria-schema";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  // Receives (tableName, rows[]) for every insert issued inside the transaction.
  insert: vi.fn(),
  recordEndpointFeedback: vi.fn(),
  refundAlexandriaFeedback: vi.fn(),
  hasRecentAlexandriaActivity: vi.fn(),
  getRecentAlexandriaCalls: vi.fn(),
  forwardExchangeToolFeedback: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("./alexandria-refund", () => ({
  refundAlexandriaFeedback: mocks.refundAlexandriaFeedback,
}));
vi.mock("../../../lib/alexandria-activity", () => ({
  hasRecentAlexandriaActivity: mocks.hasRecentAlexandriaActivity,
  getRecentAlexandriaCalls: mocks.getRecentAlexandriaCalls,
}));
vi.mock("../../../lib/exchange", () => ({
  forwardExchangeToolFeedback: mocks.forwardExchangeToolFeedback,
}));
vi.mock("../../../db/connection", () => ({
  db: { transaction: mocks.transaction },
}));
const tx = {
  insert: (table: Table) => ({
    values: (rows: object | object[]) =>
      mocks.insert(getTableName(table), Array.isArray(rows) ? rows : [rows]),
  }),
};
const inserted = (table: string) =>
  mocks.insert.mock.calls
    .filter(([name]) => name === table)
    .flatMap(([, rows]) => rows as Record<string, unknown>[]);
const parentRows = () => inserted("alexandria_feedback");
const providerRows = () => inserted("alexandria_feedback_providers");
const capabilityRows = () => inserted("alexandria_feedback_capabilities");
const callRows = () => inserted("alexandria_feedback_calls");
vi.mock("../../../lib/logger", () => ({ logger: { error: mocks.logError } }));
vi.mock("./record", () => ({
  recordEndpointFeedback: mocks.recordEndpointFeedback,
}));
vi.mock("./record-options", () => ({
  endpointFeedbackRecordOptions: (options: unknown) => options,
}));

import { config } from "../../../config";
import { feedbackController } from "./controller";
import { issueFeedbackToken } from "../../../lib/alexandria-feedback-token";

const minimal = {
  endpoint: "alexandria",
  rating: "partial",
  requestedWebsite: {
    url: "https://sam.gov",
    requestedFunctionality:
      "Find active contracts by agency and export their attachments as CSV.",
  },
  rationale: "Found contract summaries but could not retrieve attachments.",
};
const teamId = "01933161-0000-7000-8000-000000000001";
const jobId = "01933161-0000-7000-8000-000000000002";
const originalDbAuthentication = config.USE_DB_AUTHENTICATION;
let flags: Record<string, unknown>;
let authTeam: string;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: authTeam },
    acuc: { api_key_id: 42, org_id: "org-1", flags },
  });
  next();
});
app.post("/v2/feedback", feedbackController as any);
const submit = (body: object) => request(app).post("/v2/feedback").send(body);

beforeEach(() => {
  vi.clearAllMocks();
  config.USE_DB_AUTHENTICATION = true;
  authTeam = teamId;
  flags = {};
  mocks.transaction.mockImplementation(
    async (run: (tx: unknown) => Promise<void>) => run(tx),
  );
  mocks.insert.mockResolvedValue(undefined);
  mocks.hasRecentAlexandriaActivity.mockResolvedValue(true);
  mocks.getRecentAlexandriaCalls.mockResolvedValue([]);
  mocks.refundAlexandriaFeedback.mockResolvedValue({
    creditsRefunded: 1,
    creditsRefundedToday: 1,
    dailyRefundCap: 10,
  });
});
afterAll(() => {
  config.USE_DB_AUTHENTICATION = originalDbAuthentication;
});

it.each(["good", "partial", "bad"])(
  "records a %s session without job lookup and refunds it",
  async rating => {
    const response = await submit({ ...minimal, rating });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      feedbackId: expect.any(String),
      creditsRefunded: 1,
      creditsRefundedToday: 1,
      dailyRefundCap: 10,
    });
    expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.refundAlexandriaFeedback).toHaveBeenCalledExactlyOnceWith({
      feedbackId: response.body.feedbackId,
      teamId,
      orgId: "org-1",
      rating,
      requestedUrl: minimal.requestedWebsite.url,
    });
    expect(parentRows()).toEqual([
      {
        id: response.body.feedbackId,
        team_id: teamId,
        api_key_id: 42,
        api_version: "v2",
        rating,
        requested_url: minimal.requestedWebsite.url,
        requested_functionality:
          minimal.requestedWebsite.requestedFunctionality,
        rationale: minimal.rationale,
        objective: null,
        origin: "api",
        integration: null,
        schema_version: 2,
      },
    ]);
    expect(providerRows()).toEqual([]);
    expect(capabilityRows()).toEqual([]);
    expect(callRows()).toEqual([]);
  },
);

it("records the trimmed objective behind the session", async () => {
  const response = await submit({
    ...minimal,
    objective: "  Build a list of open federal IT contracts to bid on.  ",
  });
  expect(response.status).toBe(200);
  expect(parentRows()).toEqual([
    expect.objectContaining({
      objective: "Build a list of open federal IT contracts to bid on.",
    }),
  ]);
});

it.each(["endpoint", "rating", "requestedWebsite", "rationale"])(
  "requires %s",
  async field => {
    const response = await submit({ ...minimal, [field]: undefined });
    expect(response.status).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

it.each(["url", "requestedFunctionality"])(
  "requires requestedWebsite.%s",
  async field => {
    const response = await submit({
      ...minimal,
      requestedWebsite: { ...minimal.requestedWebsite, [field]: undefined },
    });
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

it("rejects the unpublished categories discriminator", async () => {
  const response = await submit({
    ...minimal,
    endpoint: undefined,
    categories: ["alexandria"],
  });
  expect(response.status).toBe(400);
  expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
});

it.each(["search", "scrape", "parse", "map"])(
  "still requires a job ID for %s feedback",
  async endpoint => {
    const response = await submit({
      endpoint,
      rating: "bad",
      missingContent: [{ topic: "Required data" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
  },
);

it.each([
  { endpoint: ["alexandria"] },
  { endpoint: "unknown" },
  { endpoint: null },
  { categories: ["alexandria"] },
  { requestedWebsite: "https://sam.gov" },
  { requestedWebsite: { ...minimal.requestedWebsite, url: "ftp://sam.gov" } },
  { requestedWebsite: { ...minimal.requestedWebsite, url: "not a website" } },
  {
    requestedWebsite: {
      ...minimal.requestedWebsite,
      requestedFunctionality: " ",
    },
  },
  { requestedWebsite: { ...minimal.requestedWebsite, extra: "not allowed" } },
  { requestedVertical: "government" },
  { rationale: " " },
  { rationale: "x".repeat(2001) },
  { objective: " " },
  { objective: "x".repeat(2001) },
  { objective: ["Find contracts"] },
  { rating: true },
  { jobId },
  { endpoint: "search", jobId },
  { extra: "not allowed" },
  { search: [] },
  { scrape: [] },
  { task: "Find current contracts" },
  { assessment: "The response was incomplete." },
  {
    providerFeedback: { name: "sam.gov", issue: "other", why: "Slow response" },
  },
  {
    providerFeedback: [
      { issue: "missing_provider", why: "Need contract attachments" },
    ],
  },
  { providerFeedback: [{ name: "sam.gov", why: "Need contract attachments" }] },
  { providerFeedback: [{ name: "sam.gov", issue: "missing_provider" }] },
  {
    providerFeedback: [
      {
        name: " ",
        issue: "missing_provider",
        why: "Need contract attachments",
      },
    ],
  },
  {
    providerFeedback: [
      { name: "sam.gov", issue: "execution_error", why: "Request failed" },
    ],
  },
  {
    providerFeedback: [
      { name: "sam.gov", issue: "missing_capability", why: "No such tool" },
    ],
  },
  { providerFeedback: [{ name: "sam.gov", issue: "other", why: " " }] },
  {
    providerFeedback: [
      { name: "sam.gov", issue: "other", why: "Request failed", extra: true },
    ],
  },
  {
    capabilityFeedback: [
      {
        provider: "sam.gov",
        issue: "execution_error",
        why: "Request timed out",
      },
    ],
  },
  {
    capabilityFeedback: [
      { name: "contracts", issue: "execution_error", why: "Request timed out" },
    ],
  },
  {
    capabilityFeedback: [
      { name: "contracts", provider: "sam.gov", why: "Request timed out" },
    ],
  },
  {
    capabilityFeedback: [
      { name: "contracts", provider: "sam.gov", issue: "execution_error" },
    ],
  },
  {
    capabilityFeedback: [
      {
        name: "contracts",
        provider: "sam.gov",
        issue: "missing_provider",
        why: "No matching tool",
      },
    ],
  },
  {
    capabilityFeedback: [
      {
        name: "contracts",
        provider: "sam.gov",
        issue: "other",
        why: "Request failed",
        extra: true,
      },
    ],
  },
])("rejects malformed feedback %j", async fields => {
  const response = await submit({ ...minimal, ...fields });
  expect(response.status).toBe(400);
  expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
});

it("preserves website requirements and provider/capability feedback for the session", async () => {
  const evidence = {
    providerFeedback: [
      {
        name: "sam.gov",
        issue: "insufficient_coverage",
        why: "The provider returns summaries without attachments.",
      },
    ],
    capabilityFeedback: [
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
        issue: "execution_error",
        why: "The second page request returned a timeout.",
      },
    ],
  };
  const response = await submit({ ...minimal, ...evidence });
  expect(response.status).toBe(200);
  const feedbackId = response.body.feedbackId;
  expect(parentRows()).toEqual([
    expect.objectContaining({
      id: feedbackId,
      requested_url: minimal.requestedWebsite.url,
      requested_functionality: minimal.requestedWebsite.requestedFunctionality,
      rationale: minimal.rationale,
    }),
  ]);
  expect(providerRows()).toEqual([
    {
      feedback_id: feedbackId,
      team_id: teamId,
      position: 0,
      name: "sam.gov",
      issue: "insufficient_coverage",
      why: evidence.providerFeedback[0].why,
    },
  ]);
  expect(capabilityRows()).toEqual([
    {
      feedback_id: feedbackId,
      team_id: teamId,
      position: 0,
      name: "download-attachments",
      provider: "sam.gov",
      issue: "new_capability_request",
      why: evidence.capabilityFeedback[0].why,
      requested_functionality:
        evidence.capabilityFeedback[0].requestedFunctionality,
    },
    {
      feedback_id: feedbackId,
      team_id: teamId,
      position: 1,
      name: "contracts",
      provider: "sam.gov",
      issue: "execution_error",
      why: evidence.capabilityFeedback[1].why,
      requested_functionality: null,
    },
  ]);
});

it.each([
  "missing_provider",
  "insufficient_coverage",
  "provider_unavailable",
  "other",
])(
  "accepts provider issue %s independently of capability feedback",
  async issue => {
    const providerFeedback = [
      { name: "sam.gov", issue, why: "Need complete contract data." },
    ];
    expect((await submit({ ...minimal, providerFeedback })).status).toBe(200);
    expect(providerRows()).toEqual([
      expect.objectContaining({ position: 0, ...providerFeedback[0] }),
    ]);
    expect(capabilityRows()).toEqual([]);
  },
);

it.each([
  "missing_capability",
  "insufficient_functionality",
  "incorrect_result",
  "execution_error",
  "other",
])(
  "accepts capability issue %s with or without requested functionality",
  async issue => {
    for (const requestedFunctionality of [
      undefined,
      "Return the complete contract data as CSV.",
    ]) {
      const capabilityFeedback = [
        {
          name: "contracts",
          provider: "sam.gov",
          issue,
          why: "The returned data did not satisfy the request.",
          ...(requestedFunctionality ? { requestedFunctionality } : {}),
        },
      ];
      mocks.insert.mockClear();
      expect((await submit({ ...minimal, capabilityFeedback })).status).toBe(
        200,
      );
      expect(capabilityRows()).toEqual([
        {
          feedback_id: parentRows()[0].id,
          team_id: teamId,
          position: 0,
          name: "contracts",
          provider: "sam.gov",
          issue,
          why: capabilityFeedback[0].why,
          requested_functionality: requestedFunctionality ?? null,
        },
      ]);
    }
  },
);

it.each([undefined, "", " "])(
  "requires nonempty functionality for a new capability request: %j",
  async requestedFunctionality => {
    const payload = {
      ...minimal,
      capabilityFeedback: [
        {
          name: "download-attachments",
          provider: "sam.gov",
          issue: "new_capability_request",
          why: "Need the source contract documents.",
          requestedFunctionality,
        },
      ],
    };
    expect((await submit(payload)).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    const parsed = alexandriaFeedbackSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["capabilityFeedback", 0, "requestedFunctionality"],
        }),
      );
    }
  },
);

it("allows omitted or empty optional feedback arrays", async () => {
  for (const fields of [
    {},
    { providerFeedback: [] },
    { capabilityFeedback: [] },
  ]) {
    expect((await submit({ ...minimal, ...fields })).status).toBe(200);
  }
});

it.each([
  [undefined, null],
  [null, null],
  ["cli", "cli"],
  [" cli ", "cli"],
  ["_custom", "_custom"],
  ["_" + "x".repeat(99), "_" + "x".repeat(99)],
])("accepts and normalizes integration %j", async (integration, expected) => {
  expect((await submit({ ...minimal, integration })).status).toBe(200);
  expect(parentRows()).toEqual([
    expect.objectContaining({ integration: expected }),
  ]);
});

it.each(["unsupported", " ", "_" + "x".repeat(100)])(
  "rejects invalid integration %j before persistence",
  async integration => {
    const response = await submit({ ...minimal, integration });
    expect(response.status).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

it.each(["providerFeedback", "capabilityFeedback"])(
  "accepts 20 entries and rejects 21 in %s",
  async field => {
    const entry = {
      name: "contracts",
      issue: "other",
      why: "Incomplete",
      ...(field === "capabilityFeedback" ? { provider: "sam.gov" } : {}),
    };
    for (const length of [20, 21]) {
      mocks.transaction.mockClear();
      const response = await submit({
        ...minimal,
        [field]: Array.from({ length }, () => ({ ...entry })),
      });
      expect(response.status).toBe(length === 20 ? 200 : 400);
      expect(mocks.transaction).toHaveBeenCalledTimes(length === 20 ? 1 : 0);
    }
  },
);

it.each([
  ["providerFeedback", "name", 200],
  ["providerFeedback", "why", 2000],
  ["capabilityFeedback", "name", 200],
  ["capabilityFeedback", "provider", 200],
  ["capabilityFeedback", "why", 2000],
  ["capabilityFeedback", "requestedFunctionality", 2000],
] as const)("bounds %s.%s to %i characters", async (array, field, limit) => {
  const entry = {
    name: "contracts",
    issue: "other",
    why: "Incomplete",
    ...(array === "capabilityFeedback" ? { provider: "sam.gov" } : {}),
  };
  for (const length of [limit, limit + 1]) {
    mocks.transaction.mockClear();
    const response = await submit({
      ...minimal,
      [array]: [{ ...entry, [field]: "x".repeat(length) }],
    });
    expect(response.status).toBe(length === limit ? 200 : 400);
    expect(mocks.transaction).toHaveBeenCalledTimes(length === limit ? 1 : 0);
  }
});

it("limits website URLs to 2048 characters and accepts HTTP and HTTPS", async () => {
  for (const protocol of ["http", "https"]) {
    const prefix = `${protocol}://example.com/`;
    for (const length of [2048, 2049]) {
      const response = await submit({
        ...minimal,
        requestedWebsite: {
          ...minimal.requestedWebsite,
          url: prefix + "x".repeat(length - prefix.length),
        },
      });
      expect(response.status).toBe(length === 2048 ? 200 : 400);
    }
  }
});

it("bounds the complete UTF-8 evidence payload", async () => {
  const response = await submit({
    ...minimal,
    providerFeedback: Array.from({ length: 4 }, () => ({
      name: "sam.gov",
      issue: "insufficient_coverage",
      why: "界".repeat(1000),
    })),
  });
  expect(response.status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("applies the payload limit after normalizing feedback", async () => {
  const response = await submit({
    ...minimal,
    rationale: " ".repeat(9 * 1024) + minimal.rationale,
  });
  expect(response.status).toBe(200);
  expect(parentRows()).toEqual([
    expect.objectContaining({ rationale: minimal.rationale }),
  ]);
});

it.each([
  { forceZDR: true },
  { scrapeZDR: "forced" },
  { searchZDR: "forced" },
  { searchZDR: "forced-zdr" },
  { searchZDR: "forced-anon" },
])("skips persistence for forced retention flags %j", async teamFlags => {
  flags = teamFlags;
  const response = await submit(minimal);
  expect(response.status).toBe(200);
  expect(response.body.feedbackId).toBe("00000000-0000-0000-0000-000000000000");
  expect(response.body.creditsRefunded).toBe(0);
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.refundAlexandriaFeedback).not.toHaveBeenCalled();
  expect(mocks.getRecentAlexandriaCalls).not.toHaveBeenCalled();
  expect(mocks.forwardExchangeToolFeedback).not.toHaveBeenCalled();
});

it("returns the refund outcome, including cap and duplicate warnings", async () => {
  const outcome = {
    creditsRefunded: 0,
    creditsRefundedToday: 10,
    dailyRefundCap: 10,
    dailyCapReached: true,
    warning: "Daily Alexandria feedback refund cap reached.",
  };
  mocks.refundAlexandriaFeedback.mockResolvedValueOnce(outcome);
  const response = await submit(minimal);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    success: true,
    feedbackId: expect.any(String),
    ...outcome,
  });
});

it("rejects feedback outside the window after the team's last Alexandria call", async () => {
  mocks.hasRecentAlexandriaActivity.mockResolvedValue(false);
  const response = await submit(minimal);
  expect(response.status).toBe(409);
  expect(response.body).toEqual({
    success: false,
    feedbackErrorCode: "FEEDBACK_WINDOW_EXPIRED",
    error: `Alexandria feedback must be submitted within ${config.ALEXANDRIA_FEEDBACK_WINDOW_SEC} seconds of an Alexandria search, discovery, or execution, or name its calls with valid feedback tokens.`,
  });
  expect(mocks.hasRecentAlexandriaActivity).toHaveBeenCalledWith(teamId);
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.refundAlexandriaFeedback).not.toHaveBeenCalled();
  expect(mocks.forwardExchangeToolFeedback).not.toHaveBeenCalled();
});

it("fails closed when the feedback window cannot be checked", async () => {
  const error = new Error("redis down");
  mocks.hasRecentAlexandriaActivity.mockRejectedValue(error);
  const response = await submit(minimal);
  expect(response.status).toBe(500);
  expect(response.body.feedbackErrorCode).toBe("INTERNAL");
  expect(mocks.logError).toHaveBeenCalledWith(
    "Failed to check the Alexandria feedback window",
    { error, teamId },
  );
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.refundAlexandriaFeedback).not.toHaveBeenCalled();
});

it("validates the body before checking the window", async () => {
  mocks.hasRecentAlexandriaActivity.mockResolvedValue(false);
  const response = await submit({ ...minimal, rationale: undefined });
  expect(response.status).toBe(400);
  expect(mocks.hasRecentAlexandriaActivity).not.toHaveBeenCalled();
});

it("honors team opt-out", async () => {
  flags = { searchFeedbackOptOut: true };
  const response = await submit(minimal);
  expect(response.status).toBe(403);
  expect(response.body.feedbackErrorCode).toBe("TEAM_OPTED_OUT");
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.refundAlexandriaFeedback).not.toHaveBeenCalled();
});

it.each(["preview", "preview_example", "preview_keyless_example"])(
  "rejects preview team %s",
  async team => {
    authTeam = team;
    const response = await submit(minimal);
    expect(response.status).toBe(403);
    expect(response.body.feedbackErrorCode).toBe("PREVIEW_TEAM_NOT_ALLOWED");
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

it("rejects deployments without database authentication", async () => {
  config.USE_DB_AUTHENTICATION = false;
  const response = await submit(minimal);
  expect(response.status).toBe(503);
  expect(response.body.feedbackErrorCode).toBe("DB_DISABLED");
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it.each([
  [new Error("sensitive database query payload"), null],
  [Object.assign(new Error("sensitive detail"), { code: "23514" }), "23514"],
  [
    new DrizzleQueryError(
      "INSERT INTO alexandria_feedback VALUES ($1)",
      ["sensitive feedback payload"],
      Object.assign(new Error("sensitive database detail"), { code: "23514" }),
    ),
    "23514",
  ],
  [{ code: "sensitive database detail" }, null],
  [{ code: { detail: "sensitive feedback payload" } }, null],
  [null, null],
])("logs only SQLSTATE on persistence failure %#", async (error, errorCode) => {
  mocks.insert.mockRejectedValueOnce(error);
  const response = await submit(minimal);
  expect(response.status).toBe(500);
  expect(response.body).toEqual({
    success: false,
    feedbackErrorCode: "INTERNAL",
    error: "Failed to record feedback.",
  });
  expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
    "Failed to record Alexandria feedback",
    { feedbackId: expect.any(String), errorCode },
  );
  expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("sensitive");
  expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
  expect(mocks.refundAlexandriaFeedback).not.toHaveBeenCalled();
  expect(mocks.forwardExchangeToolFeedback).not.toHaveBeenCalled();
});

it.each(["search", "scrape", "parse", "map"])(
  "preserves the existing %s job feedback path",
  async endpoint => {
    mocks.recordEndpointFeedback.mockResolvedValueOnce({
      status: 200,
      body: { success: true, feedbackId: jobId, creditsRefunded: 1 },
    });
    const response = await submit({
      endpoint,
      jobId,
      rating: "bad",
      note: "The expected page content was missing.",
      missingContent: [{ topic: "Required data" }],
    });
    expect(response.status).toBe(200);
    expect(response.body.creditsRefunded).toBe(1);
    expect(mocks.recordEndpointFeedback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ endpoint, jobId }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

describe("call attribution", () => {
  const now = 1_800_000_000_000;
  const originalSecret = config.EXCHANGE_INTERNAL_SECRET;
  const recent = (requestId: string, provider: string, ageSec: number) => ({
    requestId,
    provider,
    capability: "lookup",
    at: now - ageSec * 1000,
  });
  const token = (
    requestId: string,
    provider: string,
    options: { team?: string; at?: number } = {},
  ) =>
    issueFeedbackToken(
      {
        requestId,
        teamId: options.team ?? teamId,
        provider,
        capability: "lookup",
      },
      options.at ?? now - 60_000,
    )!;
  const callRow = (
    position: number,
    request_id: string,
    provider: string,
    attribution: string,
    rating: string | null = null,
  ) => ({
    feedback_id: expect.any(String),
    team_id: teamId,
    position,
    request_id,
    provider,
    capability: "lookup",
    rating,
    attribution,
  });
  let originalWindow: number;
  let clock: { mockRestore: () => void };
  beforeEach(() => {
    originalWindow = config.ALEXANDRIA_FEEDBACK_WINDOW_SEC;
    config.ALEXANDRIA_FEEDBACK_WINDOW_SEC = 1200;
    config.EXCHANGE_INTERNAL_SECRET = "internal-secret";
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
    mocks.getRecentAlexandriaCalls.mockResolvedValue([
      recent("req-3", "sec", 10),
      recent("req-2", "fred", 60),
      recent("req-2", "bls", 60),
      recent("req-3", "sec", 120),
      recent("req-1", "census", 1500),
    ]);
  });
  afterEach(() => {
    config.ALEXANDRIA_FEEDBACK_WINDOW_SEC = originalWindow;
    config.EXCHANGE_INTERNAL_SECRET = originalSecret;
    clock.mockRestore();
  });

  it("attributes to the calls named by valid tokens, with per-call ratings", async () => {
    const fred = token("req-2", "fred");
    const sec = token("req-3", "sec");
    const response = await submit({
      ...minimal,
      tokens: [fred, sec, fred],
      callRatings: [{ token: sec, rating: "bad" }],
    });
    expect(response.status).toBe(200);
    expect(response.body.rejectedTokens).toBeUndefined();
    expect(mocks.getRecentAlexandriaCalls).not.toHaveBeenCalled();
    expect(callRows()).toEqual([
      callRow(0, "req-2", "fred", "token"),
      callRow(1, "req-3", "sec", "token", "bad"),
    ]);
    expect(
      callRows().every(row => row.feedback_id === response.body.feedbackId),
    ).toBe(true);
  });

  it("accepts a token-attributed rating after the window has closed", async () => {
    mocks.hasRecentAlexandriaActivity.mockResolvedValue(false);
    const response = await submit({
      ...minimal,
      callRatings: [{ token: token("req-1", "census"), rating: "good" }],
    });
    expect(response.status).toBe(200);
    expect(mocks.hasRecentAlexandriaActivity).not.toHaveBeenCalled();
    expect(mocks.refundAlexandriaFeedback).toHaveBeenCalledOnce();
    expect(callRows()).toEqual([
      callRow(0, "req-1", "census", "token", "good"),
    ]);
  });

  it("rejects tokens that are forged, expired, from another team or unsigned", async () => {
    const valid = token("req-2", "fred");
    const [version, payload, signature] = valid.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forged = [
      version,
      Buffer.from(
        JSON.stringify([claims[0], "bls", ...claims.slice(2)]),
      ).toString("base64url"),
      signature,
    ].join(".");
    const response = await submit({
      ...minimal,
      tokens: [
        valid,
        forged,
        token("req-2", "bls", { at: now - 25 * 3600_000 }),
        token("req-2", "bls", { team: "01933161-0000-7000-8000-00000000000f" }),
        "v1.not-a-token",
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.rejectedTokens).toBe(4);
    expect(callRows()).toEqual([callRow(0, "req-2", "fred", "token")]);
  });

  it("falls back to the window when no token verifies, and closes when the window has", async () => {
    const stale = token("req-2", "fred", { at: now - 25 * 3600_000 });
    mocks.hasRecentAlexandriaActivity.mockResolvedValue(false);
    const closed = await submit({ ...minimal, tokens: [stale] });
    expect(closed.status).toBe(409);
    expect(closed.body.feedbackErrorCode).toBe("FEEDBACK_WINDOW_EXPIRED");
    mocks.hasRecentAlexandriaActivity.mockResolvedValue(true);
    const open = await submit({ ...minimal, tokens: [stale] });
    expect(open.status).toBe(200);
    expect(open.body.rejectedTokens).toBe(1);
    expect(callRows()[0]).toEqual(callRow(0, "req-3", "sec", "window"));
  });

  it("does not verify tokens without a signing key", async () => {
    const valid = token("req-2", "fred");
    config.EXCHANGE_INTERNAL_SECRET = undefined as never;
    const response = await submit({ ...minimal, tokens: [valid] });
    expect(response.status).toBe(200);
    expect(response.body.rejectedTokens).toBe(1);
    expect(callRows().every(row => row.attribution === "window")).toBe(true);
  });

  it("falls back to the distinct calls inside the window", async () => {
    expect((await submit(minimal)).status).toBe(200);
    expect(callRows()).toEqual([
      callRow(0, "req-3", "sec", "window"),
      callRow(1, "req-2", "fred", "window"),
      callRow(2, "req-2", "bls", "window"),
    ]);
  });

  it("records feedback without calls when none are remembered", async () => {
    mocks.getRecentAlexandriaCalls.mockResolvedValue([]);
    expect((await submit(minimal)).status).toBe(200);
    expect(callRows()).toEqual([]);
    expect(parentRows()).toHaveLength(1);
  });

  it.each([
    { tokens: [""] },
    { tokens: ["x".repeat(1025)] },
    { tokens: Array.from({ length: 21 }, (_, i) => `t${i}`) },
    { callRatings: [{ token: "t", rating: "great" }] },
    { callRatings: [{ token: "t" }] },
    {
      callRatings: Array.from({ length: 21 }, (_, i) => ({
        token: `t${i}`,
        rating: "good",
      })),
    },
    { requestId: "req-2" },
  ])("rejects invalid token fields %j", async extra => {
    expect((await submit({ ...minimal, ...extra })).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("keeps tokens out of the 8 KiB payload bound", async () => {
    const tokens = Array.from({ length: 20 }, (_, i) =>
      token(`${i}`.padStart(64, "a"), "x".repeat(200)),
    );
    expect(JSON.stringify(tokens).length).toBeGreaterThan(8 * 1024);
    expect((await submit({ ...minimal, tokens })).status).toBe(200);
  });

  it("forwards the rating and its token calls to the Exchange after the refund", async () => {
    const fred = token("req-2", "fred");
    const response = await submit({
      ...minimal,
      rating: "bad",
      origin: "mcp",
      tokens: [fred],
      callRatings: [{ token: token("req-3", "sec"), rating: "good" }],
    });
    expect(mocks.forwardExchangeToolFeedback).toHaveBeenCalledExactlyOnceWith({
      teamId,
      feedbackId: response.body.feedbackId,
      occurredAt: new Date(now).toISOString(),
      rating: "bad",
      origin: "mcp",
      attribution: "token",
      calls: [
        {
          requestId: "req-2",
          provider: "fred",
          capability: "lookup",
          rating: null,
        },
        {
          requestId: "req-3",
          provider: "sec",
          capability: "lookup",
          rating: "good",
        },
      ],
    });
    expect(
      mocks.refundAlexandriaFeedback.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.forwardExchangeToolFeedback.mock.invocationCallOrder[0],
    );
  });

  it("forwards window ratings even when no calls are attributed", async () => {
    mocks.getRecentAlexandriaCalls.mockResolvedValue([]);
    await submit(minimal);
    expect(mocks.forwardExchangeToolFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: "window",
        calls: [],
        origin: "api",
      }),
    );
  });

  it("does not let a failing forward affect the response", async () => {
    mocks.forwardExchangeToolFeedback.mockReturnValue(new Promise(() => {}));
    const response = await submit(minimal);
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
