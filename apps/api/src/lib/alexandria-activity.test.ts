const mocks = vi.hoisted(() => {
  const pipeline = {
    lpush: vi.fn(),
    ltrim: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn(),
  };
  return {
    set: vi.fn(),
    exists: vi.fn(),
    lrange: vi.fn(),
    warn: vi.fn(),
    pipeline,
    multi: vi.fn(() => pipeline),
  };
});
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: {
    set: mocks.set,
    exists: mocks.exists,
    lrange: mocks.lrange,
    multi: mocks.multi,
  },
}));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn } }));

import { config } from "../config";
import {
  getRecentAlexandriaCalls,
  hasRecentAlexandriaActivity,
  markAlexandriaActivity,
  markAlexandriaCalls,
  recordAlexandriaActivity,
  recordAlexandriaCalls,
} from "./alexandria-activity";

const teamId = "01933161-0000-7000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.set.mockResolvedValue("OK");
  for (const step of ["lpush", "ltrim", "expire"] as const)
    mocks.pipeline[step].mockReturnValue(mocks.pipeline);
  mocks.pipeline.exec.mockResolvedValue([]);
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

const calls = [
  { requestId: "req-1", provider: "fred", capability: "series" },
  { requestId: "req-1", provider: "sec", capability: "filings" },
];

it("keeps the last 20 provider calls for the feedback window's lifetime", async () => {
  const original = config.ALEXANDRIA_FEEDBACK_WINDOW_SEC;
  config.ALEXANDRIA_FEEDBACK_WINDOW_SEC = 1500;
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    await recordAlexandriaCalls(teamId, calls);
  } finally {
    config.ALEXANDRIA_FEEDBACK_WINDOW_SEC = original;
    clock.mockRestore();
  }
  const key = `alexandria:calls:${teamId}`;
  expect(mocks.pipeline.lpush).toHaveBeenCalledExactlyOnceWith(
    key,
    ...calls.map(call => JSON.stringify({ ...call, at: 1_700_000_000_000 })),
  );
  expect(mocks.pipeline.ltrim).toHaveBeenCalledExactlyOnceWith(key, 0, 19);
  expect(mocks.pipeline.expire).toHaveBeenCalledExactlyOnceWith(key, 1500);
  expect(mocks.pipeline.exec).toHaveBeenCalledOnce();
});

it("logs a command error the transaction resolves with", async () => {
  const error = new Error("WRONGTYPE");
  mocks.pipeline.exec.mockResolvedValue([
    [null, 1],
    [error, null],
    [null, 1],
  ]);
  await expect(recordAlexandriaCalls(teamId, calls)).resolves.toBeUndefined();
  expect(mocks.warn).toHaveBeenCalledWith("Failed to record Alexandria calls", {
    error,
    teamId,
  });
});

it("skips the write when there are no calls", async () => {
  await recordAlexandriaCalls(teamId, []);
  expect(mocks.multi).not.toHaveBeenCalled();
});

it("resolves and logs when recording calls fails, also in the fire-and-forget form", async () => {
  const error = new Error("redis down");
  mocks.pipeline.exec.mockRejectedValue(error);
  await expect(recordAlexandriaCalls(teamId, calls)).resolves.toBeUndefined();
  expect(mocks.warn).toHaveBeenCalledWith("Failed to record Alexandria calls", {
    error,
    teamId,
  });
  mocks.warn.mockClear();
  expect(markAlexandriaCalls(teamId, calls)).toBeUndefined();
  await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled());
});

it("reads recent calls newest first and drops malformed entries", async () => {
  mocks.lrange.mockResolvedValue([
    JSON.stringify({ ...calls[1], at: 2 }),
    "not json",
    JSON.stringify({ requestId: "req-0", provider: "fred", at: 1 }),
    JSON.stringify({ ...calls[0], at: 1, extra: true }),
  ]);
  await expect(getRecentAlexandriaCalls(teamId)).resolves.toEqual([
    { ...calls[1], at: 2 },
    { ...calls[0], at: 1 },
  ]);
  expect(mocks.lrange).toHaveBeenCalledWith(
    `alexandria:calls:${teamId}`,
    0,
    19,
  );
});

it("returns no recent calls when the read fails", async () => {
  const error = new Error("redis down");
  mocks.lrange.mockRejectedValue(error);
  await expect(getRecentAlexandriaCalls(teamId)).resolves.toEqual([]);
  expect(mocks.warn).toHaveBeenCalledWith(
    "Failed to read recent Alexandria calls",
    { error, teamId },
  );
});
