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
  logError: vi.fn(),
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
vi.mock("../../../lib/logger", () => ({ logger: { error: mocks.logError } }));
vi.mock("./record", () => ({
  recordEndpointFeedback: mocks.recordEndpointFeedback,
}));
vi.mock("./record-options", () => ({
  endpointFeedbackRecordOptions: (options: unknown) => options,
}));

import { config } from "../../../config";
import { feedbackController } from "./controller";

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
    acuc: { api_key_id: 42, flags },
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
});
afterAll(() => {
  config.USE_DB_AUTHENTICATION = originalDbAuthentication;
});

it.each(["good", "partial", "bad"])(
  "records a %s session without job lookup or refund",
  async rating => {
    const response = await submit({ ...minimal, rating });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      feedbackId: expect.any(String),
      creditsRefunded: 0,
    });
    expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
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
        origin: "api",
        integration: null,
        schema_version: 2,
      },
    ]);
    expect(providerRows()).toEqual([]);
    expect(capabilityRows()).toEqual([]);
  },
);

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
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("honors team opt-out", async () => {
  flags = { searchFeedbackOptOut: true };
  const response = await submit(minimal);
  expect(response.status).toBe(403);
  expect(response.body.feedbackErrorCode).toBe("TEAM_OPTED_OUT");
  expect(mocks.transaction).not.toHaveBeenCalled();
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
