import express from "express";
import request from "supertest";
import type { FeedbackJobRow } from "./internal-types";

const fixture = vi.hoisted(() => ({
  job: undefined as FeedbackJobRow | undefined,
  lookup: vi.fn(),
  insert: vi.fn(),
  alexandriaInsert: vi.fn(),
  refund: vi.fn(),
  refundedToday: vi.fn(),
}));
vi.mock("./feedback-store", () => ({
  lookupFeedbackJob: fixture.lookup,
  insertFeedback: fixture.insert,
  findExistingFeedback: async () => ({
    id: "already-recorded",
    credits_refunded: 1,
  }),
  updateFeedbackRefundDetails: async () => null,
}));
vi.mock("../../../db/connection", () => ({
  db: {
    transaction: async (run: (tx: unknown) => Promise<void>) =>
      run({ insert: () => ({ values: fixture.alexandriaInsert }) }),
  },
}));
vi.mock("./refund-totals", () => ({
  sumCreditsRefundedToday: fixture.refundedToday,
}));
vi.mock("../../../services/autumn/autumn.service", () => ({
  SEARCH_CREDITS_FEATURE_ID: "SEARCH_CREDITS",
  featureIdForBillingEndpoint: (endpoint: string) =>
    endpoint === "search" ? "SEARCH_CREDITS" : "CREDITS",
  autumnService: { refundCredits: fixture.refund },
}));

import { config } from "../../../config";
import { feedbackController } from "./controller";
import { searchFeedbackController } from "../search-feedback";

const original = { ...config };
const jobId = "01933161-0000-7000-8000-000000000001";
const teamId = "01933161-0000-7000-8000-000000000002";
const now = Date.now();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: teamId },
    acuc: { flags: {}, org_id: "test-org" },
  });
  next();
});
app.post("/v2/feedback", feedbackController as any);
app.post("/v2/search/:jobId/feedback", searchFeedbackController as any);

type Route = "legacy-search" | "search" | "scrape" | "parse" | "map";
const routes: Route[] = ["legacy-search", "search", "scrape", "parse", "map"];
const stores = ["postgres", "bigtable"] as const;
const submit = (route: Route) =>
  request(app)
    .post(
      route === "legacy-search"
        ? `/v2/search/${jobId}/feedback`
        : "/v2/feedback",
    )
    .send({
      ...(route === "legacy-search" ? {} : { endpoint: route, jobId }),
      rating: "bad",
      ...(route === "search" || route === "legacy-search"
        ? { missingContent: [{ topic: "Contract attachments" }] }
        : { note: "The returned content was incomplete." }),
    });

function job(route: Route, store: (typeof stores)[number], ageSec: number) {
  const endpoint = route === "legacy-search" ? "search" : route;
  const window =
    endpoint === "search"
      ? config.SEARCH_FEEDBACK_MAX_AGE_SEC
      : config.FEEDBACK_MAX_AGE_SEC;
  fixture.job = {
    id: jobId,
    request_id: jobId,
    endpoint,
    team_id: teamId,
    credits_cost: 2,
    is_successful: true,
    options: {},
    created_at: new Date(now - ageSec * 1000).toISOString(),
    ...(store === "bigtable"
      ? {
          feedback_deadline_ms: now + (window - ageSec) * 1000,
          zero_data_retention: false,
        }
      : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  Object.assign(config, original, {
    USE_DB_AUTHENTICATION: true,
    FEEDBACK_REFUND_ENABLED: true,
    SEARCH_FEEDBACK_MAX_AGE_SEC: 120,
    FEEDBACK_MAX_AGE_SEC: 120,
  });
  fixture.job = undefined;
  fixture.lookup.mockImplementation(
    async (endpoint: string, id: string, team: string) =>
      fixture.job?.endpoint === endpoint &&
      fixture.job.id === id &&
      fixture.job.team_id === team
        ? fixture.job
        : null,
  );
  fixture.insert.mockResolvedValue(null);
  fixture.alexandriaInsert.mockResolvedValue(undefined);
  fixture.refundedToday.mockResolvedValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(config, original);
});

describe.each(routes)("%s job feedback keeps its submission window", route => {
  it.each(stores)(
    "accepts %s feedback before the 120-second deadline",
    async store => {
      job(route, store, 119);
      expect((await submit(route)).status).toBe(200);
      expect(fixture.lookup).toHaveBeenCalledWith(
        route === "legacy-search" ? "search" : route,
        jobId,
        teamId,
      );
      expect(fixture.insert).toHaveBeenCalledTimes(1);
      expect(fixture.alexandriaInsert).not.toHaveBeenCalled();
    },
  );

  it.each(stores)(
    "rejects %s feedback after the 120-second deadline",
    async store => {
      job(route, store, 121);
      const response = await submit(route);
      expect(response.status).toBe(409);
      expect(response.body.feedbackErrorCode).toBe("FEEDBACK_WINDOW_EXPIRED");
      expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.refund).not.toHaveBeenCalled();
      expect(fixture.alexandriaInsert).not.toHaveBeenCalled();
    },
  );

  it("honors the stored Bigtable deadline even for a recently created job", async () => {
    job(route, "bigtable", 1);
    fixture.job!.feedback_deadline_ms = now - 1;
    expect((await submit(route)).body.feedbackErrorCode).toBe(
      "FEEDBACK_WINDOW_EXPIRED",
    );
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.refund).not.toHaveBeenCalled();
  });
});

it.each(stores)(
  "accepts Alexandria feedback when the session's original %s search has expired",
  async store => {
    job("search", store, 30 * 60);
    const expiredSearch = await submit("search");
    expect(expiredSearch.status).toBe(409);
    expect(expiredSearch.body.feedbackErrorCode).toBe(
      "FEEDBACK_WINDOW_EXPIRED",
    );
    expect(fixture.lookup).toHaveBeenCalledTimes(1);
    fixture.lookup.mockClear();

    const response = await request(app)
      .post("/v2/feedback")
      .send({
        endpoint: "alexandria",
        rating: "partial",
        requestedWebsite: {
          url: "https://example.com",
          requestedFunctionality: "Retrieve records and their attachments.",
        },
        rationale: "Found record summaries but could not retrieve attachments.",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      feedbackId: expect.any(String),
      creditsRefunded: 0,
    });
    expect(fixture.lookup).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.refund).not.toHaveBeenCalled();
    expect(fixture.alexandriaInsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: response.body.feedbackId,
        team_id: teamId,
        rating: "partial",
        requested_url: "https://example.com",
      }),
    );
  },
);
