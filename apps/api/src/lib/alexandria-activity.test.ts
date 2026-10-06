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
} from "./alexandria-activity";

const teamId = "01933161-0000-7000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.set.mockResolvedValue("OK");
});

it("opens a feedback window as long as the search feedback window", () => {
  markAlexandriaActivity(teamId);
  expect(mocks.set).toHaveBeenCalledExactlyOnceWith(
    `alexandria:activity:${teamId}`,
    "1",
    "EX",
    config.SEARCH_FEEDBACK_MAX_AGE_SEC,
  );
});

it("never throws when recording activity fails", async () => {
  mocks.set.mockRejectedValue(new Error("redis down"));
  expect(() => markAlexandriaActivity(teamId)).not.toThrow();
  await vi.waitFor(() =>
    expect(mocks.warn).toHaveBeenCalledWith(
      "Failed to record Alexandria activity",
      expect.objectContaining({ teamId }),
    ),
  );
});

it.each([
  [1, true],
  [0, false],
])("reports recent activity when the key exists (%i)", async (count, open) => {
  mocks.exists.mockResolvedValue(count);
  await expect(hasRecentAlexandriaActivity(teamId)).resolves.toBe(open);
  expect(mocks.exists).toHaveBeenCalledWith(`alexandria:activity:${teamId}`);
});
