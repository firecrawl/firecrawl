import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  credentials: vi.fn(),
  categories: vi.fn(),
  consume: vi.fn(),
}));
vi.mock("../../../../services/rate-limiter", () => ({
  redisRateLimitClient: { get: mock.get, set: mock.set, del: mock.del },
}));
vi.mock("../../../../services/redlock", () => ({
  redlock: { acquire: mock.acquire },
}));
vi.mock("../../../logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock("../../store", () => ({ getOrgZscalerCredentials: mock.credentials }));
vi.mock("./lookup-queue", () => ({ zscalerBudgetKey: () => "tenant" }));
vi.mock("rate-limiter-flexible", () => ({
  RateLimiterRedis: class {
    consume = mock.consume;
  },
  RateLimiterRes: class {},
}));
vi.mock("./client", () => ({
  zscalerGetUrlCategories: mock.categories,
  ZscalerError: class extends Error {},
}));
import {
  evaluateZscalerSyncedRules,
  getZscalerSyncDocument,
  syncOrgZscalerRules,
} from "./sync";
let org = 0;
beforeEach(() => {
  vi.resetAllMocks();
  org++;
  mock.get.mockResolvedValue(null);
  mock.acquire.mockResolvedValue({ release: mock.release });
  mock.credentials.mockResolvedValue({ vanityDomain: "tenant" });
  mock.categories.mockResolvedValue([]);
});
it("propagates the original sync read failure", async () => {
  const error = new Error("GET failed");
  mock.get.mockRejectedValue(error);
  await expect(getZscalerSyncDocument(String(org))).rejects.toBe(error);
});
it("preserves read and release errors", async () => {
  const error = new Error("GET failed"),
    cleanup = new Error("release failed");
  mock.get.mockRejectedValue(error);
  mock.release.mockRejectedValue(cleanup);
  await expect(syncOrgZscalerRules(String(org))).rejects.toMatchObject({
    errors: [error, cleanup],
  });
});
it("propagates budget storage failure without fetching or writing a document", async () => {
  const error = new Error("consume failed");
  mock.consume.mockRejectedValue(error);
  await expect(syncOrgZscalerRules(String(org))).rejects.toBe(error);
  expect(mock.categories).not.toHaveBeenCalled();
  expect(mock.set).not.toHaveBeenCalled();
});
it("propagates document write failure without replacing it with an error document", async () => {
  const error = new Error("SET failed");
  mock.set.mockRejectedValue(error);
  await expect(syncOrgZscalerRules(String(org))).rejects.toBe(error);
  expect(mock.set).toHaveBeenCalledTimes(1);
});
it("stores a successful provider document", async () => {
  await expect(syncOrgZscalerRules(String(org))).resolves.toMatchObject({
    status: "ok",
  });
  expect(mock.release).toHaveBeenCalledTimes(1);
});
it("retains provider failure policy", async () => {
  mock.categories.mockRejectedValue(new Error("provider failed"));
  await expect(syncOrgZscalerRules(String(org))).resolves.toMatchObject({
    status: "error",
  });
});

it("fails enforcement when the awaited shared refresh fails", async () => {
  const error = new Error("refresh write failed");
  mock.set.mockRejectedValue(error);
  const settings = {
    orgId: String(org),
    deniedCategories: [],
    syncIntervalMinutes: 60,
  };
  const base = {
    url: "https://example.com",
    domain: "example.com",
    mode: "zscaler" as const,
  };
  const outcomes = await Promise.allSettled([
    evaluateZscalerSyncedRules(base.url, settings, "open", base),
    evaluateZscalerSyncedRules(base.url, settings, "open", base),
  ]);
  expect(outcomes).toEqual([
    { status: "rejected", reason: error },
    { status: "rejected", reason: error },
  ]);
  expect(mock.acquire).toHaveBeenCalledTimes(1);
});
it("evaluates the rules produced by the awaited refresh", async () => {
  mock.categories.mockResolvedValue([
    { id: "CUSTOM_01", customCategory: true, urls: ["example.com"] },
  ]);
  const base = {
    url: "https://example.com",
    domain: "example.com",
    mode: "zscaler" as const,
  };
  await expect(
    evaluateZscalerSyncedRules(
      base.url,
      {
        orgId: String(org),
        deniedCategories: ["CUSTOM_01"],
        syncIntervalMinutes: 60,
      },
      "open",
      base,
    ),
  ).resolves.toMatchObject({ allowed: false, rule: "denied-category" });
});
