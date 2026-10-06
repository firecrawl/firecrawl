import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { mocks, updater } = vi.hoisted(() => {
  const mocks = {
    // Ordered log of lock, read, write, and billing calls.
    events: [] as string[],
    lock: vi.fn(),
    todayRows: vi.fn(),
    update: vi.fn(),
    refundCredits: vi.fn(),
    logError: vi.fn(),
  };
  const updater = (scope: string) => () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        mocks.events.push(`${scope}:update:${values.credits_refunded}`);
        return mocks.update(values);
      },
    }),
  });
  return { mocks, updater };
});
vi.mock("../../../db/connection", () => ({
  db: {
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        execute: (query: unknown) => {
          mocks.events.push("tx:lock");
          return mocks.lock(query);
        },
        select: () => ({
          from: () => ({
            where: () => {
              mocks.events.push("tx:select");
              return mocks.todayRows();
            },
          }),
        }),
        update: updater("tx"),
      }),
    update: updater("db"),
  },
}));
vi.mock("../../../services/autumn/autumn.service", () => ({
  CREDITS_FEATURE_ID: "CREDITS",
  autumnService: {
    refundCredits: (params: unknown) => {
      mocks.events.push("billing");
      return mocks.refundCredits(params);
    },
  },
}));
vi.mock("../../../lib/logger", () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: mocks.logError };
  return { logger: { child: () => child } };
});

import { config } from "../../../config";
import { refundAlexandriaFeedback } from "./alexandria-refund";

const teamId = "01933161-0000-7000-8000-000000000001";
const now = new Date("2026-10-06T18:00:00.000Z");
const original = {
  enabled: config.FEEDBACK_REFUND_ENABLED,
  cap: config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS,
  websiteCap: config.ALEXANDRIA_FEEDBACK_WEBSITE_DAILY_CAP_CREDITS,
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
  mocks.events.length = 0;
  config.FEEDBACK_REFUND_ENABLED = true;
  config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS = 10;
  config.ALEXANDRIA_FEEDBACK_WEBSITE_DAILY_CAP_CREDITS = 3;
  mocks.lock.mockResolvedValue(undefined);
  mocks.todayRows.mockResolvedValue([]);
  mocks.update.mockResolvedValue(undefined);
  mocks.refundCredits.mockResolvedValue(true);
});
afterAll(() => {
  config.FEEDBACK_REFUND_ENABLED = original.enabled;
  config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS = original.cap;
  config.ALEXANDRIA_FEEDBACK_WEBSITE_DAILY_CAP_CREDITS = original.websiteCap;
});

it("reserves the refund under a per-team lock before billing, then reports it", async () => {
  mocks.todayRows.mockResolvedValue([
    { requested_host: "data.gov", credits_refunded: 1 },
  ]);
  await expect(refund()).resolves.toEqual({
    creditsRefunded: 1,
    creditsRefundedToday: 2,
    dailyRefundCap: 10,
  });
  expect(mocks.events).toEqual([
    "tx:lock",
    "tx:select",
    "tx:update:1",
    "billing",
  ]);
  const lock = new PgDialect().sqlToQuery(mocks.lock.mock.calls[0][0] as SQL);
  expect(lock.sql).toBe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
  );
  expect(lock.params).toEqual([`alexandria_feedback_refund:${teamId}`]);
  expect(mocks.refundCredits).toHaveBeenCalledExactlyOnceWith({
    teamId,
    orgId: "org-1",
    value: 1,
    idempotencyKey: "fc:refund:alexandria-feedback:feedback-1",
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
    updated_at: expect.any(String),
  });
});

it("keeps refunding the same website until its daily cap", async () => {
  mocks.todayRows.mockResolvedValue([
    { requested_host: "sam.gov", credits_refunded: 1 },
    { requested_host: "data.gov", credits_refunded: 1 },
  ]);
  await expect(refund()).resolves.toEqual({
    creditsRefunded: 1,
    creditsRefundedToday: 3,
    dailyRefundCap: 10,
  });
});

it("flags the website cap on the refund that fills it", async () => {
  mocks.todayRows.mockResolvedValue([
    { requested_host: "sam.gov", credits_refunded: 1 },
    { requested_host: "sam.gov", credits_refunded: 1 },
  ]);
  const result = await refund();
  expect(result).toMatchObject({
    creditsRefunded: 1,
    websiteCapReached: true,
    warning: expect.stringContaining("sam.gov"),
  });
  expect(result.dailyCapReached).toBeUndefined();
});

it("stops refunding a website at its daily cap, while other websites still refund", async () => {
  mocks.todayRows.mockResolvedValue([
    { requested_host: "sam.gov", credits_refunded: 1 },
    { requested_host: "sam.gov", credits_refunded: 1 },
    { requested_host: "sam.gov", credits_refunded: 1 },
  ]);
  const result = await refund({ url: "https://user@sam.gov:443/other" });
  expect(result).toMatchObject({
    creditsRefunded: 0,
    creditsRefundedToday: 3,
    websiteCapReached: true,
    warning: expect.stringContaining("sam.gov"),
  });
  expect(result.dailyCapReached).toBeUndefined();
  expect(mocks.events).toEqual(["tx:lock", "tx:select", "tx:update:0"]);
  expect(persisted()).toMatchObject({
    credits_refunded: 0,
    refund_policy: { mode: "none", matchedReason: "website_cap_reached" },
  });

  mocks.events.length = 0;
  await expect(refund({ url: "https://data.gov" })).resolves.toMatchObject({
    creditsRefunded: 1,
    creditsRefundedToday: 4,
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
  expect(mocks.events).not.toContain("billing");
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
  expect(mocks.events).toEqual(["db:update:0"]);
  expect(persisted()).toMatchObject({
    refund_policy: { enabled: false, matchedReason: "refunds_disabled" },
  });
});

it("does not refund when the reservation fails", async () => {
  mocks.todayRows.mockRejectedValue(new Error("db unavailable"));
  await expect(refund()).resolves.toMatchObject({ creditsRefunded: 0 });
  expect(mocks.events).toEqual(["tx:lock", "tx:select", "db:update:0"]);
  expect(persisted()).toMatchObject({
    refund_policy: { matchedReason: "refund_totals_unavailable" },
  });
});

it.each([
  ["billing does not confirm", { orgId: "org-1", billed: false }],
  ["the team has no org", { orgId: null, billed: true }],
])("reports and keeps 0 credits when %s", async (_case, { orgId, billed }) => {
  mocks.refundCredits.mockResolvedValue(billed);
  const result = await refund({ orgId });
  expect(result).toMatchObject({
    creditsRefunded: 0,
    creditsRefundedToday: 0,
  });
  expect(result.dailyCapReached).toBeUndefined();
  expect(mocks.events.at(-1)).toBe("db:update:0");
  expect(persisted()).toMatchObject({
    credits_refunded: 0,
    refund_policy: { matchedReason: "refund_not_confirmed" },
  });
  if (orgId === null) expect(mocks.refundCredits).not.toHaveBeenCalled();
});

it("does not throw when resetting an unconfirmed refund fails", async () => {
  mocks.refundCredits.mockResolvedValue(false);
  mocks.update
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("write failed"));
  await expect(refund()).resolves.toMatchObject({ creditsRefunded: 0 });
});
