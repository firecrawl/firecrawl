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
  requestedWebsite: "https://sam.gov",
  requestedVertical: "government",
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
          requestedVertical: "government",
        },
      }),
    );
  },
);

it.each([
  "web_general",
  "social",
  "business",
  "research",
  "developer",
  "news",
  "government",
  "finance",
  "other",
])("accepts the PR 4616 vertical %s", requestedVertical => {
  expect(
    alexandriaFeedbackSchema.safeParse({ ...minimal, requestedVertical })
      .success,
  ).toBe(true);
});

it.each(["endpoint", "rating", "requestedWebsite", "requestedVertical"])(
  "requires %s",
  async field => {
    const response = await submit({ ...minimal, [field]: undefined });
    expect(response.status).toBe(400);
    expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
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
  { requestedWebsite: "ftp://sam.gov" },
  { requestedWebsite: "not a website" },
  { requestedVertical: "unknown" },
  { rating: true },
  { jobId },
  { endpoint: "search", jobId },
  { extra: "not allowed" },
  {
    search: [
      { kind: "useful", basis: "output", detail: "Useful official result" },
    ],
  },
  {
    scrape: [
      {
        kind: "correct",
        basis: "source_comparison",
        detail: "Matches the official source",
      },
    ],
  },
  {
    scrape: [
      {
        kind: "incorrect",
        basis: "output",
        reason: "off_topic",
        detail: "Incorrect returned value",
      },
    ],
  },
  { task: "x".repeat(2001) },
])("rejects malformed feedback %j", async fields => {
  const response = await submit({ ...minimal, ...fields });
  expect(response.status).toBe(400);
  expect(response.body.feedbackErrorCode).toBe("INVALID_BODY");
  expect(mocks.values).not.toHaveBeenCalled();
  expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
});

it("preserves Search and Scrape evidence for the overall session", async () => {
  const evidence = {
    task: "Find current government contracts",
    assessment: "The results were useful but incomplete.",
    search: [
      {
        kind: "useful",
        source: "web",
        position: 1,
        vertical: "government",
        basis: "output",
        detail: "The official site listed active solicitations.",
      },
      {
        kind: "missing",
        vertical: "government",
        knownSources: ["https://sam.gov"],
        basis: "expectation",
        detail: "Expected downloadable contract attachments.",
      },
    ],
    scrape: [
      {
        kind: "incomplete",
        reason: "pagination",
        format: "json",
        location: "contracts",
        basis: "source_comparison",
        detail: "The response included only the first page.",
        comparison: {
          reference: "https://sam.gov",
          detail: "The official source lists two pages of results.",
        },
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

it("bounds the complete UTF-8 evidence payload", async () => {
  const response = await submit({
    ...minimal,
    search: Array.from({ length: 4 }, () => ({
      kind: "missing",
      vertical: "government",
      basis: "expectation",
      detail: "界".repeat(1000),
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
