import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  getGroup: vi.fn(),
  getGroupNumericStats: vi.fn(),
  getGroupJobs: vi.fn(),
  getCrawlError: vi.fn(),
}));

vi.mock("../../../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
  getCrawlError: mocks.getCrawlError,
  getCrawlExpiry: vi.fn().mockResolvedValue(new Date(0)),
  getCrawlQualifiedJobCount: vi.fn(),
  getDoneJobsOrderedLength: vi.fn(),
  getDoneJobsOrderedUntil: vi.fn(),
  getLastDoneJobTimestamp: vi.fn().mockResolvedValue(null),
  isCrawlKickoffFinished: vi.fn(),
}));

vi.mock("../../../services/worker/nuq-router", () => ({
  crawlGroup: { getGroup: mocks.getGroup },
  scrapeQueue: {
    getGroupAnyJob: vi.fn().mockResolvedValue(null),
    getGroupNumericStats: mocks.getGroupNumericStats,
    getGroupJobs: mocks.getGroupJobs,
  },
}));

vi.mock("../../../services/redis", () => ({
  redisEvictConnection: { smembers: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../../../lib/request-credits-store", () => ({
  readRequestCredits: vi.fn().mockResolvedValue(3),
}));

vi.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { crawlStatusController } from "../crawl-status";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function makeReq(query: Record<string, string> = {}) {
  return {
    params: { jobId: JOB_ID },
    query,
    auth: { team_id: TEAM_ID },
    protocol: "http",
    host: "localhost",
  } as any;
}

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const doc = (url: string) => ({
  id: url,
  returnvalue: { markdown: url, metadata: { sourceURL: url } },
});

// Two completed pages. Pages 0-1 are returned by the first request and the
// page past them (skip=2) is empty. `pending` jobs are still queued or running.
function mockCrawl(options: {
  cancelled: boolean;
  groupStatus: string;
  pending?: number;
  completed?: number;
  crawlError?: string;
}) {
  mocks.getCrawlError.mockResolvedValue(options.crawlError ?? null);
  mocks.getGroup.mockResolvedValue({ status: options.groupStatus });
  mocks.getCrawl.mockResolvedValue({
    team_id: TEAM_ID,
    cancelled: options.cancelled,
    createdAt: Date.now(),
  });
  mocks.getGroupNumericStats.mockResolvedValue({
    completed: options.completed ?? 2,
    active: options.pending ?? 0,
  });
  mocks.getGroupJobs.mockImplementation(
    async (_id: string, _status: string, limit: number, offset: number) =>
      [doc("https://example.com/a"), doc("https://example.com/b")].slice(
        offset,
        offset + limit,
      ),
  );
}

async function getStatus(query: Record<string, string> = {}) {
  const res = makeRes();
  await crawlStatusController(makeReq(query), res);
  return res.json.mock.calls[0][0];
}

describe("crawl status next cursor", () => {
  it("ends the cursor after the last page of a cancelled crawl", async () => {
    mockCrawl({ cancelled: true, groupStatus: "active" });

    const first = await getStatus();
    expect(first.status).toBe("cancelled");
    expect(first.data).toHaveLength(2);
    expect(first.next).toBeUndefined();

    // Following a cursor past the end must not hand back the same cursor.
    const past = await getStatus({ skip: "2" });
    expect(past.data).toHaveLength(0);
    expect(past.next).toBeUndefined();
  });

  it("ends the cursor of a cancelled crawl whose pending jobs are still counted", async () => {
    // total is 5 (2 completed + 3 still queued or running), but only completed
    // jobs have pages, so the page past them is the last one.
    mockCrawl({ cancelled: true, groupStatus: "active", pending: 3 });

    const past = await getStatus({ skip: "2" });
    expect(past.total).toBe(5);
    expect(past.data).toHaveLength(0);
    expect(past.next).toBeUndefined();
  });

  it("ends the cursor after the last page of a completed crawl", async () => {
    mockCrawl({ cancelled: false, groupStatus: "completed" });

    const first = await getStatus();
    expect(first.status).toBe("completed");
    expect(first.next).toBeUndefined();
  });

  it("keeps the cursor while the crawl is still running", async () => {
    mockCrawl({ cancelled: false, groupStatus: "active" });

    const first = await getStatus();
    expect(first.status).toBe("scraping");
    expect(first.next).toBe(`http://localhost/v2/crawl/${JOB_ID}?skip=2`);
  });

  it("keeps the cursor while more completed pages remain", async () => {
    mockCrawl({ cancelled: true, groupStatus: "active" });

    const first = await getStatus({ limit: "1" });
    expect(first.data).toHaveLength(1);
    expect(first.next).toBe(
      `http://localhost/v2/crawl/${JOB_ID}?skip=1&limit=1`,
    );
  });

  it("keeps the cursor on a full page of a cancelled crawl whose jobs finished during the request", async () => {
    mockCrawl({ cancelled: true, groupStatus: "active", completed: 1 });

    const first = await getStatus({ limit: "2" });
    expect(first.data).toHaveLength(2);
    expect(first.next).toBe(
      `http://localhost/v2/crawl/${JOB_ID}?skip=2&limit=2`,
    );

    const past = await getStatus({ skip: "2", limit: "2" });
    expect(past.data).toHaveLength(0);
    expect(past.next).toBeUndefined();
  });

  it("keeps the cursor when the response size cap cuts a page short", async () => {
    mockCrawl({ cancelled: true, groupStatus: "active", completed: 1 });
    const big = {
      id: "big",
      returnvalue: { markdown: "x".repeat(11 * 1024 * 1024), metadata: {} },
    };
    mocks.getGroupJobs.mockImplementation(
      async (_id: string, _status: string, limit: number, offset: number) =>
        [big, doc("https://example.com/b")].slice(offset, offset + limit),
    );

    const first = await getStatus();
    expect(first.data).toHaveLength(1);
    expect(first.next).toBe(`http://localhost/v2/crawl/${JOB_ID}?skip=1`);
  });

  it("ends the cursor of a crawl whose group was cancelled", async () => {
    mockCrawl({ cancelled: false, groupStatus: "cancelled" });

    const first = await getStatus();
    expect(first.status).toBe("cancelled");
    expect(first.data).toHaveLength(2);
    expect(first.next).toBeUndefined();

    const past = await getStatus({ skip: "2" });
    expect(past.data).toHaveLength(0);
    expect(past.next).toBeUndefined();
  });

  it("returns no cursor for a crawl that failed during kickoff", async () => {
    mockCrawl({
      cancelled: false,
      groupStatus: "completed",
      completed: 0,
      crawlError: "queue full",
    });

    const first = await getStatus();
    expect(first.status).toBe("failed");
    expect(first.next).toBeUndefined();
  });

  it("ends the cursor after a full last page of a completed crawl", async () => {
    mockCrawl({ cancelled: false, groupStatus: "completed" });

    const first = await getStatus({ limit: "2" });
    expect(first.data).toHaveLength(2);
    expect(first.next).toBeUndefined();
  });
});
