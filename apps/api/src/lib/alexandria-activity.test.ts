const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  exists: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { set: mocks.set, exists: mocks.exists },
}));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn } }));

import { config } from "../config";
import {
  hasRecentAlexandriaActivity,
  markAlexandriaActivity,
  recordAlexandriaActivity,
} from "./alexandria-activity";

const teamId = "01933161-0000-7000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.set.mockResolvedValue("OK");
});

it("opens the Alexandria window, independent of the search feedback window", async () => {
  const original = {
    alexandria: config.ALEXANDRIA_FEEDBACK_WINDOW_SEC,
    search: config.SEARCH_FEEDBACK_MAX_AGE_SEC,
  };
  config.ALEXANDRIA_FEEDBACK_WINDOW_SEC = 1500;
  config.SEARCH_FEEDBACK_MAX_AGE_SEC = 90;
  try {
    await recordAlexandriaActivity(teamId);
  } finally {
    config.ALEXANDRIA_FEEDBACK_WINDOW_SEC = original.alexandria;
    config.SEARCH_FEEDBACK_MAX_AGE_SEC = original.search;
  }
  expect(mocks.set).toHaveBeenCalledExactlyOnceWith(
    `alexandria:activity:${teamId}`,
    "1",
    "EX",
    1500,
  );
});

it("resolves and logs when recording activity fails", async () => {
  const error = new Error("redis down");
  mocks.set.mockRejectedValue(error);
  await expect(recordAlexandriaActivity(teamId)).resolves.toBeUndefined();
  expect(mocks.warn).toHaveBeenCalledWith(
    "Failed to record Alexandria activity",
    { error, teamId },
  );
});

it("records activity without blocking or throwing in the fire-and-forget form", async () => {
  mocks.set.mockRejectedValue(new Error("redis down"));
  expect(markAlexandriaActivity(teamId)).toBeUndefined();
  await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled());
});

it.each([
  [1, true],
  [0, false],
])("reports recent activity when the key exists (%i)", async (count, open) => {
  mocks.exists.mockResolvedValue(count);
  await expect(hasRecentAlexandriaActivity(teamId)).resolves.toBe(open);
  expect(mocks.exists).toHaveBeenCalledWith(`alexandria:activity:${teamId}`);
});

// The feedback controller turns this rejection into a 500; swallowing it into
// false would wrongly report an expired window.
it("rejects when the window lookup fails", async () => {
  const error = new Error("redis down");
  mocks.exists.mockRejectedValue(error);
  await expect(hasRecentAlexandriaActivity(teamId)).rejects.toBe(error);
});
