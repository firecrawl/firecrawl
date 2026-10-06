const mocks = vi.hoisted(() => ({
  todayRows: vi.fn(),
  update: vi.fn(),
  refundCredits: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../../../db/connection", () => ({
  db: {
    select: () => ({ from: () => ({ where: mocks.todayRows }) }),
    update: () => ({
      set: (values: object) => ({ where: () => mocks.update(values) }),
    }),
  },
}));
vi.mock("../../../services/autumn/autumn.service", () => ({
  CREDITS_FEATURE_ID: "CREDITS",
  autumnService: { refundCredits: mocks.refundCredits },
}));
vi.mock("../../../lib/logger", () => {
  const child = {
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
  };
  return { logger: { child: () => child } };
});

import { config } from "../../../config";
import { refundAlexandriaFeedback } from "./alexandria-refund";

const teamId = "01933161-0000-7000-8000-000000000001";
const now = new Date("2026-10-06T18:00:00.000Z");
const original = {
  enabled: config.FEEDBACK_REFUND_ENABLED,
  cap: config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS,
};
const refund = (overrides: { orgId?: string | null; url?: string } = {}) =>
  refundAlexandriaFeedback({
    feedbackId: "feedback-1",
    teamId,
    orgId: overrides.orgId === undefined ? "org-1" : overrides.orgId,
    rating: "partial",
    requestedUrl: overrides.url ?? "https://SAM.gov/contracts",
    now,
  });
const persisted = () => mocks.update.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  config.FEEDBACK_REFUND_ENABLED = true;
  config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS = 10;
  mocks.todayRows.mockResolvedValue([]);
  mocks.update.mockResolvedValue(undefined);
  mocks.refundCredits.mockResolvedValue(undefined);
});
afterAll(() => {
  config.FEEDBACK_REFUND_ENABLED = original.enabled;
  config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS = original.cap;
});

it("refunds 1 credit for the first feedback on a website today", async () => {
  mocks.todayRows.mockResolvedValue([
    { requested_host: "data.gov", credits_refunded: 1 },
  ]);
  await expect(refund()).resolves.toEqual({
    creditsRefunded: 1,
    creditsRefundedToday: 2,
    dailyRefundCap: 10,
  });
  expect(mocks.refundCredits).toHaveBeenCalledExactlyOnceWith({
    teamId,
    orgId: "org-1",
    value: 1,
    idempotencyKey: `fc:refund:alexandria-feedback:${teamId}:2026-10-06:sam.gov`,
    featureId: "CREDITS",
    properties: {
      source: "feedback",
      endpoint: "alexandria",
      feedbackId: "feedback-1",
      rating: "partial",
      refundPolicy: "alexandria_feedback",
    },
  });
  expect(persisted()).toEqual({
    credits_refunded: 1,
    refund_policy: {
      version: "feedback_refund_v1",
      enabled: true,
      endpoint: "alexandria",
      mode: "flat",
      refundableRatings: ["good", "partial", "bad"],
      matchedReason: "alexandria_feedback",
      flatCredits: 1,
      maxCredits: 1,
    },
  });
});

it("does not refund a second feedback for the same website on the same UTC day", async () => {
  mocks.todayRows.mockResolvedValue([
    { requested_host: "sam.gov", credits_refunded: 1 },
  ]);
  const result = await refund({ url: "https://user@sam.gov:443/other" });
  expect(result).toMatchObject({
    creditsRefunded: 0,
    creditsRefundedToday: 1,
    alreadySubmitted: true,
    warning: expect.stringContaining("sam.gov"),
  });
  expect(mocks.refundCredits).not.toHaveBeenCalled();
  expect(persisted()).toMatchObject({
    credits_refunded: 0,
    refund_policy: {
      mode: "none",
      matchedReason: "host_already_refunded_today",
    },
  });
});

it("stops refunding at the daily Alexandria cap", async () => {
  config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS = 2;
  mocks.todayRows.mockResolvedValue([
    { requested_host: "a.example", credits_refunded: 1 },
    { requested_host: "b.example", credits_refunded: 1 },
  ]);
  const result = await refund();
  expect(result).toMatchObject({
    creditsRefunded: 0,
    creditsRefundedToday: 2,
    dailyRefundCap: 2,
    dailyCapReached: true,
  });
  expect(mocks.refundCredits).not.toHaveBeenCalled();
  expect(persisted()).toMatchObject({
    refund_policy: { matchedReason: "daily_cap_reached" },
  });
});

it("flags the cap as reached on the refund that fills it", async () => {
  config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS = 1;
  await expect(refund()).resolves.toMatchObject({
    creditsRefunded: 1,
    creditsRefundedToday: 1,
    dailyCapReached: true,
  });
});

it("records no refund when refunds are disabled", async () => {
  config.FEEDBACK_REFUND_ENABLED = false;
  await expect(refund()).resolves.toMatchObject({ creditsRefunded: 0 });
  expect(mocks.todayRows).not.toHaveBeenCalled();
  expect(mocks.refundCredits).not.toHaveBeenCalled();
  expect(persisted()).toMatchObject({
    refund_policy: { enabled: false, matchedReason: "refunds_disabled" },
  });
});

it("does not refund when today's refunds cannot be read", async () => {
  mocks.todayRows.mockRejectedValue(new Error("db unavailable"));
  await expect(refund()).resolves.toMatchObject({ creditsRefunded: 0 });
  expect(mocks.refundCredits).not.toHaveBeenCalled();
  expect(persisted()).toMatchObject({
    refund_policy: { matchedReason: "refund_totals_unavailable" },
  });
});

it("reports the refund without calling billing when the team has no org", async () => {
  await expect(refund({ orgId: null })).resolves.toMatchObject({
    creditsRefunded: 1,
  });
  expect(mocks.refundCredits).not.toHaveBeenCalled();
  expect(mocks.logError).toHaveBeenCalledWith(
    "Feedback refund skipped: no org for the team",
  );
});

it("keeps the refund result when persisting refund details fails", async () => {
  mocks.update.mockRejectedValue(new Error("write failed"));
  await expect(refund()).resolves.toMatchObject({ creditsRefunded: 1 });
});
