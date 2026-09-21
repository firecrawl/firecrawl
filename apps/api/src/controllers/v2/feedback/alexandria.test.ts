import express from "express";
import request from "supertest";
import { alexandriaFeedbackSchema } from "./alexandria-schema";

const mocks = vi.hoisted(() => ({
  values: vi.fn(),
  recordEndpointFeedback: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../../../db/connection", () => ({
  db: { insert: () => ({ values: mocks.values }) },
}));
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
  mocks.values.mockResolvedValue(undefined);
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
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: response.body.feedbackId,
        endpoint: "alexandria",
        team_id: teamId,
        api_key_id: 42,
        overall_rating: rating,
        comment: minimal.rationale,
        job_id: null,
        search_id: null,
        request_id: null,
        job_status: null,
        credits_billed: 0,
        credits_refunded: 0,
        refund_policy: null,
        metadata: {
          schemaVersion: 1,
          endpoint: "alexandria",
          requestedWebsite: minimal.requestedWebsite,
          rationale: minimal.rationale,
        },
      }),
    );
  },
);

it.each(["endpoint", "rating", "requestedWebsite", "rationale"])(
  "requires %s",
  async field => {
    const response = await submit({ ...minimal, [field]: undefined });
    expect(response.status).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
    expect(mocks.values).not.toHaveBeenCalled();
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
    expect(mocks.values).not.toHaveBeenCalled();
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
  expect(mocks.values).not.toHaveBeenCalled();
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
    expect(mocks.values).not.toHaveBeenCalled();
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
  expect(mocks.values).not.toHaveBeenCalled();
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
  expect(mocks.values).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining(evidence),
    }),
  );
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
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ providerFeedback }),
      }),
    );
  },
);

it.each([
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
      expect((await submit({ ...minimal, capabilityFeedback })).status).toBe(
        200,
      );
      expect(mocks.values).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ capabilityFeedback }),
        }),
      );
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
    expect(mocks.values).not.toHaveBeenCalled();
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
  expect(mocks.values).not.toHaveBeenCalled();
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
  expect(mocks.values).not.toHaveBeenCalled();
});

it("honors team opt-out", async () => {
  flags = { searchFeedbackOptOut: true };
  const response = await submit(minimal);
  expect(response.status).toBe(403);
  expect(response.body.feedbackErrorCode).toBe("TEAM_OPTED_OUT");
  expect(mocks.values).not.toHaveBeenCalled();
});

it.each(["preview", "preview_example", "preview_keyless_example"])(
  "rejects preview team %s",
  async team => {
    authTeam = team;
    const response = await submit(minimal);
    expect(response.status).toBe(403);
    expect(response.body.feedbackErrorCode).toBe("PREVIEW_TEAM_NOT_ALLOWED");
    expect(mocks.values).not.toHaveBeenCalled();
  },
);

it("rejects deployments without database authentication", async () => {
  config.USE_DB_AUTHENTICATION = false;
  const response = await submit(minimal);
  expect(response.status).toBe(503);
  expect(response.body.feedbackErrorCode).toBe("DB_DISABLED");
  expect(mocks.values).not.toHaveBeenCalled();
});

it("returns a failure without logging the payload if persistence fails", async () => {
  mocks.values.mockRejectedValueOnce(
    new Error("sensitive database query payload"),
  );
  const response = await submit(minimal);
  expect(response.status).toBe(500);
  expect(response.body.feedbackErrorCode).toBe("INTERNAL");
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
    expect(mocks.values).not.toHaveBeenCalled();
  },
);
