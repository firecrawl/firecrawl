import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateUser: vi.fn(),
  getCrawl: vi.fn(),
  getCrawlJobs: vi.fn(),
  getDoneJobsOrdered: vi.fn(),
  getQueueJobs: vi.fn(),
  getJobsWithStatuses: vi.fn(),
  getDocuments: vi.fn(),
}));

vi.mock("../../types", () => ({
  RateLimiterMode: { CrawlStatus: "crawl-status" },
}));
vi.mock("../auth", () => ({ authenticateUser: mocks.authenticateUser }));
vi.mock("../../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
  getCrawlJobs: mocks.getCrawlJobs,
  getDoneJobsOrdered: mocks.getDoneJobsOrdered,
  getCrawlError: vi.fn().mockResolvedValue(null),
  getCrawlExpiry: vi.fn().mockResolvedValue(new Date(0)),
}));
vi.mock("../../lib/concurrency-limit", () => ({
  getConcurrencyLimitedJobs: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock("../../services/worker/nuq-router", () => ({
  scrapeQueue: {
    getJobs: mocks.getQueueJobs,
    getJobsWithStatuses: mocks.getJobsWithStatuses,
  },
}));
vi.mock("../v1/crawl-status", () => ({ getJobs: mocks.getDocuments }));
vi.mock("../v2/crawl-status", () => ({ getJobs: mocks.getDocuments }));
vi.mock("../../lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../../lib/deployment", () => ({
  getErrorContactMessage: () => "Unexpected error",
}));

import { crawlStatusWSController as v1 } from "../v1/crawl-status-ws";
import { crawlStatusWSController as v2 } from "../v2/crawl-status-ws";

function makeSocket() {
  return {
    readyState: 1,
    send: vi.fn((_data: string, callback: (error?: Error) => void) =>
      callback(),
    ),
    close: vi.fn(),
  };
}

function makeRequest() {
  return { params: { jobId: "crawl" }, path: "/crawl/crawl" };
}

function setJobs(ids: string[], done: string[] = []) {
  const completed = new Set(done);
  mocks.getCrawlJobs.mockResolvedValue(ids);
  mocks.getDoneJobsOrdered.mockResolvedValue(done);
  mocks.getQueueJobs.mockResolvedValue(
    ids.map(id => ({ id, status: completed.has(id) ? "completed" : "active" })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.authenticateUser.mockResolvedValue({ success: true, team_id: "team" });
  mocks.getCrawl.mockResolvedValue({ team_id: "team", cancelled: false });
  mocks.getJobsWithStatuses.mockResolvedValue([]);
  mocks.getDocuments.mockImplementation(async (ids: string[]) =>
    ids.map(id => ({ id, returnvalue: { markdown: id } })),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each([
  ["v1", v1],
  ["v2", v2],
] as const)("%s crawl watcher completed jobs", (_version, controller) => {
  it("preserves catchup order and polls only jobs not previously delivered", async () => {
    setJobs(
      ["first", "second", "new", "failed", "pending"],
      ["second", "first"],
    );
    mocks.getJobsWithStatuses
      .mockResolvedValueOnce([{ id: "new" }, { id: "failed" }])
      .mockResolvedValueOnce([]);
    mocks.getDocuments.mockImplementation(async (ids: string[]) =>
      ids.map(id => ({
        id,
        returnvalue: id === "failed" ? undefined : { markdown: id },
      })),
    );
    const ws = makeSocket();

    await controller(ws as any, makeRequest() as any);
    const catchup = JSON.parse(ws.send.mock.calls[0][0]);
    expect(catchup.data.completed).toBe(2);
    expect(catchup.data.data).toEqual([
      { markdown: "second" },
      { markdown: "first" },
    ]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.getJobsWithStatuses).toHaveBeenNthCalledWith(
      1,
      ["new", "failed", "pending"],
      ["completed", "failed"],
    );
    expect(JSON.parse(ws.send.mock.calls[1][0])).toEqual({
      type: "document",
      data: { markdown: "new" },
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.getJobsWithStatuses).toHaveBeenNthCalledWith(
      2,
      ["pending"],
      ["completed", "failed"],
    );
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("closes after a completion burst larger than the function argument limit", async () => {
    const ids = Array.from({ length: 200_000 }, (_, i) => `job-${i}`);
    setJobs(ids);
    // Failed jobs still complete the crawl, but have no document to send.
    mocks.getJobsWithStatuses.mockResolvedValue(ids.map(id => ({ id })));
    mocks.getDocuments.mockResolvedValue([]);
    const ws = makeSocket();

    await controller(ws as any, makeRequest() as any);
    await vi.advanceTimersByTimeAsync(2000);

    expect(mocks.getJobsWithStatuses).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(
      1000,
      JSON.stringify({ type: "done" }),
    );
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a fully completed catchup terminal", async () => {
    setJobs(["first", "second"], ["second", "first"]);
    const ws = makeSocket();

    await controller(ws as any, makeRequest() as any);
    await vi.advanceTimersByTimeAsync(1000);

    expect(JSON.parse(ws.send.mock.calls[0][0]).data.status).toBe("completed");
    expect(ws.close).toHaveBeenCalledWith(
      1000,
      JSON.stringify({ type: "done" }),
    );
    expect(mocks.getJobsWithStatuses).not.toHaveBeenCalled();
  });

  it("does not poll a missing crawl", async () => {
    mocks.getCrawl.mockResolvedValue(null);
    const ws = makeSocket();

    await controller(ws as any, makeRequest() as any);
    await vi.advanceTimersByTimeAsync(1000);

    expect(ws.close).toHaveBeenCalledWith(
      1008,
      JSON.stringify({ type: "error", error: "Job not found" }),
    );
    expect(mocks.getCrawlJobs).not.toHaveBeenCalled();
  });

  it("does not read jobs belonging to another team", async () => {
    mocks.getCrawl.mockResolvedValue({ team_id: "other-team" });
    const ws = makeSocket();

    await controller(ws as any, makeRequest() as any);
    await vi.advanceTimersByTimeAsync(1000);

    expect(ws.close).toHaveBeenCalledWith(
      3003,
      JSON.stringify({ type: "error", error: "Forbidden" }),
    );
    expect(mocks.getCrawlJobs).not.toHaveBeenCalled();
  });
});
