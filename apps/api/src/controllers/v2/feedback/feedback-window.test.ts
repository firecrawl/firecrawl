import express from "express";
import request from "supertest";
import type { FeedbackJobRow } from "./internal-types";

const fixture = vi.hoisted(() => ({
  job: undefined as FeedbackJobRow | undefined,
  insert: vi.fn(),
  refund: vi.fn(),
  refundedToday: vi.fn(),
}));
vi.mock("./feedback-store", () => ({
  lookupFeedbackJob: async (endpoint: string, id: string, team: string) =>
    fixture.job?.endpoint === endpoint &&
    fixture.job.id === id &&
    fixture.job.team_id === team
      ? fixture.job
      : null,
  insertFeedback: fixture.insert,
  findExistingFeedback: async () => ({
    id: "already-recorded",
    credits_refunded: 1,
  }),
  updateFeedbackRefundDetails: async () => null,
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

type Route = "legacy-search" | "search" | "scrape";
const routes: Route[] = ["legacy-search", "search", "scrape"];
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
      ...(route === "scrape"
        ? { note: "The returned content was incomplete." }
        : { missingContent: [{ topic: "Contract attachments" }] }),
    });

function job(route: Route, store: (typeof stores)[number], ageSec: number) {
  const endpoint = route === "scrape" ? "scrape" : "search";
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
          refund_class: endpoint === "search" ? "search" : "scrape_basic",
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
  });
  fixture.insert.mockResolvedValue(null);
  fixture.refundedToday.mockResolvedValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(config, original);
});

describe.each(routes)("%s feedback after an Alexandria workflow", route => {
  it.each(stores)(
    "accepts a 30-minute-old %s job and refunds only once",
    async store => {
      job(route, store, 30 * 60);
      const first = await submit(route);
      expect(first.status).toBe(200);
      expect(first.body.creditsRefunded).toBe(1);
      expect(fixture.refund).toHaveBeenCalledTimes(1);
      fixture.insert.mockResolvedValueOnce({ code: "23505" });
      const duplicate = await submit(route);
      expect(duplicate.status).toBe(200);
      expect(duplicate.body).toMatchObject({
        alreadySubmitted: true,
        creditsRefunded: 0,
      });
      expect(fixture.refund).toHaveBeenCalledTimes(1);
    },
  );

  it.each(stores)(
    "accepts %s feedback just before the 24-hour deadline",
    async store => {
      job(route, store, 24 * 60 * 60 - 1);
      expect((await submit(route)).status).toBe(200);
    },
  );

  it.each(stores)(
    "rejects %s feedback after the configured deadline",
    async store => {
      job(route, store, 24 * 60 * 60 + 1);
      const response = await submit(route);
      expect(response.status).toBe(409);
      expect(response.body.feedbackErrorCode).toBe("FEEDBACK_WINDOW_EXPIRED");
      expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.refund).not.toHaveBeenCalled();
    },
  );

  it("keeps the daily refund cap for delayed feedback", async () => {
    job(route, "postgres", 30 * 60);
    fixture.refundedToday.mockResolvedValue(
      route === "scrape"
        ? config.FEEDBACK_DAILY_CAP_CREDITS
        : config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS,
    );
    const response = await submit(route);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      creditsRefunded: 0,
      dailyCapReached: true,
    });
    expect(fixture.refund).not.toHaveBeenCalled();
  });

  it("rejects feedback on another team's older job", async () => {
    job(route, "postgres", 30 * 60);
    fixture.job!.team_id = "another-team";
    expect((await submit(route)).status).toBe(404);
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.refund).not.toHaveBeenCalled();
  });

  it.each(stores)(
    "respects an explicitly configured shorter %s window",
    async store => {
      config.SEARCH_FEEDBACK_MAX_AGE_SEC = 120;
      config.FEEDBACK_MAX_AGE_SEC = 120;
      job(route, store, 121);
      expect((await submit(route)).body.feedbackErrorCode).toBe(
        "FEEDBACK_WINDOW_EXPIRED",
      );
    },
  );

  it("keeps an expired Bigtable deadline written before the window changed", async () => {
    job(route, "bigtable", 30 * 60);
    fixture.job!.feedback_deadline_ms = now - 1;
    expect((await submit(route)).body.feedbackErrorCode).toBe(
      "FEEDBACK_WINDOW_EXPIRED",
    );
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.refund).not.toHaveBeenCalled();
  });
});
