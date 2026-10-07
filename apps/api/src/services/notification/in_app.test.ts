import { createInAppNotification, isDashboardOrigin } from "./in_app";
import { db } from "../../db/connection";
import { redisEvictConnection } from "../redis";

const values = vi.fn();

vi.mock("../../config", () => ({ config: { USE_DB_AUTHENTICATION: true } }));

vi.mock("../../db/connection", () => ({
  db: { insert: vi.fn(() => ({ values })) },
}));

vi.mock("../redis", () => ({
  redisEvictConnection: { set: vi.fn(), del: vi.fn() },
}));

const claims = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  claims.clear();
  values.mockResolvedValue(undefined);
  vi.mocked(redisEvictConnection.set).mockImplementation((async (
    key: string,
  ) => {
    if (claims.has(key)) return null;
    claims.add(key);
    return "OK";
  }) as any);
  vi.mocked(redisEvictConnection.del).mockImplementation((async (key: string) =>
    Number(claims.delete(key))) as any);
});

const notify = () =>
  createInAppNotification(
    "team-1",
    "crawlCompleted",
    { jobId: "crawl-1" },
    { dedupeKey: "crawl-1" },
  );

describe("deduplicated in-app notifications", () => {
  test("writes one row per key when the finishing job is redelivered", async () => {
    expect(await notify()).toBe(true);
    expect(await notify()).toBe(false);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: "team-1",
        notification_type: "crawlCompleted",
        metadata: { jobId: "crawl-1" },
      }),
    );
  });

  test("releases the claim when the write fails so a retry can notify", async () => {
    values.mockRejectedValueOnce(new Error("db down"));

    expect(await notify()).toBe(false);
    expect(await notify()).toBe(true);

    expect(values).toHaveBeenCalledTimes(2);
  });

  test("does not throw when the claim cannot be taken", async () => {
    vi.mocked(redisEvictConnection.set).mockRejectedValueOnce(
      new Error("redis down"),
    );

    expect(await notify()).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

test("only the exact dashboard origin counts", () => {
  expect(isDashboardOrigin("website")).toBe(true);
  expect(isDashboardOrigin("my-website-bot")).toBe(false);
  expect(isDashboardOrigin("api")).toBe(false);
  expect(isDashboardOrigin(undefined)).toBe(false);
});
