import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  getJobs: vi.fn(),
  getGroup: vi.fn(),
  getGroupAnyJob: vi.fn(),
  getGroupNumericStats: vi.fn(),
  getGroupJobs: vi.fn(),
  getCrawl: vi.fn(),
  getCrawlError: vi.fn(),
  getCrawlExpiry: vi.fn(),
  getLastDoneJobTimestamp: vi.fn(),
  smembers: vi.fn(),
  scard: vi.fn(),
}));

vi.mock("../services/worker/nuq-router", () => ({
  scrapeQueue: {
    getJob: mocks.getJob,
    getJobs: mocks.getJobs,
    getGroupAnyJob: mocks.getGroupAnyJob,
    getGroupNumericStats: mocks.getGroupNumericStats,
    getGroupJobs: mocks.getGroupJobs,
  },
  crawlGroup: {
    getGroup: mocks.getGroup,
  },
}));

vi.mock("../lib/crawl-redis", () => ({
  getCrawl: mocks.getCrawl,
  getCrawlError: mocks.getCrawlError,
  getCrawlExpiry: mocks.getCrawlExpiry,
  getCrawlQualifiedJobCount: vi.fn(),
  getDoneJobsOrderedLength: vi.fn(),
  getDoneJobsOrderedUntil: vi.fn(),
  getLastDoneJobTimestamp: mocks.getLastDoneJobTimestamp,
  isCrawlKickoffFinished: vi.fn(),
  getCrawlRobotsBlocked: mocks.smembers,
  getCrawlRobotsBlockedCount: mocks.scard,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { crawlErrorsController } from "../controllers/v2/crawl-errors";
import {
  crawlStatusController,
  getJob,
  getJobs,
} from "../controllers/v2/crawl-status";
import { scrapeStatusController } from "../controllers/v2/scrape-status";
import { coreErrors } from "../lib/error-serde";
import { normalizeOwnerId } from "../lib/owner-id";
import { defaultModules, queueJobStore } from "./defaults";
import type { JobStoreModule, StoredJob } from "./modules";
import { replaceService, type CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = {
  core: { name: "core", errors: coreErrors },
  logger: { error: vi.fn() },
};

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "019e6f45-7778-727d-adf0-0abe9d5062b6";

function makeRes() {
  let statusCode = 200;
  let body: any;
  const res: any = {
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      body = payload;
      return res;
    }),
  };
  return {
    res,
    result: () => ({ status: statusCode, body }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getJob.mockResolvedValue(null);
  mocks.getJobs.mockResolvedValue([]);
  mocks.getGroup.mockResolvedValue({ status: "completed" });
  mocks.getGroupAnyJob.mockResolvedValue(null);
  mocks.getGroupNumericStats.mockResolvedValue({ completed: 0, active: 0 });
  mocks.getGroupJobs.mockResolvedValue([]);
  mocks.getCrawl.mockResolvedValue(null);
  mocks.getCrawlError.mockResolvedValue(null);
  mocks.getCrawlExpiry.mockResolvedValue(new Date(0));
  mocks.getLastDoneJobTimestamp.mockResolvedValue(null);
  mocks.smembers.mockResolvedValue([]);
  mocks.scard.mockResolvedValue(0);
});

afterEach(() => {
  replaceService(undefined);
});

describe("queueJobStore", () => {
  it("reports inline results, unmetered usage, and no-op writes", async () => {
    const store = queueJobStore();
    expect(store.storesResultsExternally?.()).toBe(false);
    await expect(
      store.register({
        id: JOB_ID,
        kind: "scrape",
        ctx: { teamId: TEAM_ID, zeroDataRetention: false },
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.record(
        {
          id: JOB_ID,
          kind: "scrape",
          ctx: { teamId: TEAM_ID, zeroDataRetention: false },
        },
        {
          state: "completed",
          document: {
            markdown: "ok",
            metadata: { statusCode: 200, proxyUsed: "basic" },
          },
        },
      ),
    ).resolves.toBeUndefined();
    await expect(store.remove(JOB_ID, "scrape")).resolves.toBeUndefined();
    expect(await store.usage(JOB_ID)).toBeNull();
  });

  it("reads scrape ownership from the queue and matches normalized owner ids when input data is shed", async () => {
    const store = queueJobStore();

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "completed",
      ownerId: normalizeOwnerId("bypass"),
      data: { mode: "single_urls", team_id: "bypass" },
    });
    const rawOwner = await store.owner(JOB_ID, "scrape");
    expect(rawOwner?.teamId).toBe("bypass");
    expect(rawOwner?.matchesTeam?.("bypass")).toBe(true);
    expect(rawOwner?.matchesTeam?.(OTHER_TEAM_ID)).toBe(false);

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "completed",
      ownerId: normalizeOwnerId("bypass"),
      data: null,
    });
    const shedOwner = await store.owner(JOB_ID, "scrape");
    expect(shedOwner?.matchesTeam?.("bypass")).toBe(true);
    expect(shedOwner?.matchesTeam?.(OTHER_TEAM_ID)).toBe(false);

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "completed",
      ownerId: TEAM_ID,
      data: { mode: "crawl", team_id: TEAM_ID },
    });
    expect(await store.owner(JOB_ID, "scrape")).toBeNull();

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "completed",
      ownerId: TEAM_ID,
      data: { team_id: TEAM_ID },
    });
    expect(await store.owner(JOB_ID, "scrape")).toBeNull();
  });

  it("reads crawl and batchScrape ownership from the stored crawl record", async () => {
    const store = queueJobStore();
    mocks.getCrawl
      .mockResolvedValueOnce({ team_id: TEAM_ID })
      .mockResolvedValueOnce({ team_id: TEAM_ID });

    expect(await store.owner(JOB_ID, "crawl")).toEqual({ teamId: TEAM_ID });
    expect(await store.owner(JOB_ID, "batchScrape")).toEqual({
      teamId: TEAM_ID,
    });
    expect(await store.owner(JOB_ID, "batchScrape")).toBeNull();
  });

  it("reads terminal scrape outcomes from the queue and returns null for active or non-scrape jobs", async () => {
    const store = queueJobStore();
    const finishedAt = new Date(1_700_000_000_000);

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "completed",
      finishedAt,
      data: { mode: "single_urls" },
      returnvalue: [{ markdown: "hello" }],
    });
    expect(await store.read(JOB_ID, "scrape")).toEqual({
      state: "completed",
      document: { markdown: "hello" },
      completedAtMs: finishedAt.valueOf(),
    });

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "failed",
      finishedAt,
      data: { mode: "single_urls" },
      failedReason: "timeout",
    });
    expect(await store.read(JOB_ID, "scrape")).toEqual({
      state: "failed",
      error: "timeout",
      completedAtMs: finishedAt.valueOf(),
    });

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "completed",
      finishedAt,
      data: {},
      returnvalue: { markdown: "no-mode" },
    });
    expect(await store.read(JOB_ID, "scrape")).toBeNull();

    mocks.getJob.mockResolvedValueOnce({
      id: JOB_ID,
      status: "active",
      data: { mode: "single_urls" },
    });
    expect(await store.read(JOB_ID, "scrape")).toBeNull();
    expect(await store.read(JOB_ID, "crawl")).toBeNull();
  });
});

describe("scrapeStatusController with jobStore", () => {
  it("answers 200 from the default queueJobStore for a completed queued scrape", async () => {
    const doc = {
      markdown: "# Hello",
      metadata: { sourceURL: "https://example.com" },
    };
    mocks.getJob.mockResolvedValue({
      id: JOB_ID,
      status: "completed",
      createdAt: new Date(1_700_000_000_000),
      finishedAt: new Date(1_700_000_001_000),
      ownerId: TEAM_ID,
      data: { mode: "single_urls", team_id: TEAM_ID },
      returnvalue: doc,
    });

    await withService(testService(defaultModules(), parts), async () => {
      const ok = makeRes();
      await scrapeStatusController(
        { params: { jobId: JOB_ID }, auth: { team_id: TEAM_ID } },
        ok.res,
      );
      expect(ok.result()).toEqual({
        status: 200,
        body: { success: true, data: doc },
      });

      const forbidden = makeRes();
      await scrapeStatusController(
        { params: { jobId: JOB_ID }, auth: { team_id: OTHER_TEAM_ID } },
        forbidden.res,
      );
      expect(forbidden.result()).toEqual({
        status: 403,
        body: {
          success: false,
          error: "You are not allowed to access this resource.",
        },
      });
    });
  });

  it("honors expiry, custom matchesTeam, and missing documents from an injected jobStore", async () => {
    const doc = {
      markdown: "from custom store",
      metadata: { statusCode: 200, proxyUsed: "basic" as const },
    };
    const customStore: JobStoreModule = {
      ...queueJobStore(),
      owner: vi.fn(),
      read: vi.fn(),
    };

    await withService(
      testService(defaultModules(), parts, { jobStore: customStore }),
      async () => {
        vi.mocked(customStore.owner).mockResolvedValueOnce({
          teamId: "normalized-team",
          expiresAtMs: Date.now() + 60_000,
          matchesTeam: candidate => candidate === TEAM_ID,
        });
        vi.mocked(customStore.read).mockResolvedValueOnce({
          state: "completed",
          document: doc,
        });
        const ok = makeRes();
        await scrapeStatusController(
          { params: { jobId: JOB_ID }, auth: { team_id: TEAM_ID } },
          ok.res,
        );
        expect(ok.result()).toEqual({
          status: 200,
          body: { success: true, data: doc },
        });
        expect(mocks.getJob).not.toHaveBeenCalled();

        vi.mocked(customStore.owner).mockResolvedValueOnce({
          teamId: TEAM_ID,
          expiresAtMs: Date.now() - 1,
        });
        const expired = makeRes();
        await scrapeStatusController(
          { params: { jobId: JOB_ID }, auth: { team_id: TEAM_ID } },
          expired.res,
        );
        expect(expired.result()).toEqual({
          status: 404,
          body: { success: false, error: "Job not found." },
        });

        vi.mocked(customStore.owner).mockResolvedValueOnce({
          teamId: TEAM_ID,
          expiresAtMs: Date.now() + 60_000,
        });
        vi.mocked(customStore.read).mockResolvedValueOnce(null);
        const missing = makeRes();
        await scrapeStatusController(
          { params: { jobId: JOB_ID }, auth: { team_id: TEAM_ID } },
          missing.res,
        );
        expect(missing.result()).toEqual({
          status: 404,
          body: { success: false, error: "Job not found." },
        });
      },
    );
  });
});

describe("crawlErrorsController with jobStore", () => {
  it("delegates ownership and expiry to jobStore.owner when no Redis crawl exists", async () => {
    const owner = vi.fn();
    const customStore: JobStoreModule = { ...queueJobStore(), owner };

    await withService(
      testService(defaultModules(), parts, { jobStore: customStore }),
      async () => {
        owner.mockResolvedValueOnce({
          teamId: TEAM_ID,
          expiresAtMs: Date.now() + 60_000,
        });
        const ok = makeRes();
        await crawlErrorsController(
          {
            path: `/crawl/${JOB_ID}/errors`,
            params: { jobId: JOB_ID },
            auth: { team_id: TEAM_ID },
          } as any,
          ok.res,
        );
        expect(owner).toHaveBeenLastCalledWith(JOB_ID, "crawl");
        expect(ok.result()).toEqual({
          status: 200,
          body: { errors: [], robotsBlocked: [] },
        });

        owner.mockResolvedValueOnce({
          teamId: TEAM_ID,
          expiresAtMs: Date.now() + 60_000,
        });
        const batchOk = makeRes();
        await crawlErrorsController(
          {
            path: `/batch/scrape/${JOB_ID}/errors`,
            params: { jobId: JOB_ID },
            auth: { team_id: TEAM_ID },
          } as any,
          batchOk.res,
        );
        expect(owner).toHaveBeenLastCalledWith(JOB_ID, "batchScrape");
        expect(batchOk.result()).toEqual({
          status: 200,
          body: { errors: [], robotsBlocked: [] },
        });

        owner.mockResolvedValueOnce({
          teamId: OTHER_TEAM_ID,
          expiresAtMs: Date.now() + 60_000,
        });
        const forbidden = makeRes();
        await crawlErrorsController(
          { params: { jobId: JOB_ID }, auth: { team_id: TEAM_ID } } as any,
          forbidden.res,
        );
        expect(forbidden.result()).toEqual({
          status: 403,
          body: { success: false, error: "Forbidden" },
        });

        owner.mockResolvedValueOnce({
          teamId: TEAM_ID,
          expiresAtMs: Date.now() - 1,
        });
        const expired = makeRes();
        await crawlErrorsController(
          { params: { jobId: JOB_ID }, auth: { team_id: TEAM_ID } } as any,
          expired.res,
        );
        expect(expired.result()).toEqual({
          status: 404,
          body: { success: false, error: "Job expired" },
        });

        owner.mockResolvedValueOnce(null);
        const missing = makeRes();
        await crawlErrorsController(
          { params: { jobId: JOB_ID }, auth: { team_id: TEAM_ID } } as any,
          missing.res,
        );
        expect(missing.result()).toEqual({
          status: 404,
          body: { success: false, error: "Job not found" },
        });
      },
    );
  });
});

describe("crawlStatusController and helpers with jobStore", () => {
  it("reads metered usage and externally stored completed documents via jobStore", async () => {
    const externalDoc = {
      markdown: "stored externally",
      metadata: {
        sourceURL: "https://example.com/a",
        statusCode: 200,
        proxyUsed: "basic" as const,
      },
    };
    mocks.getCrawl.mockResolvedValue({
      team_id: TEAM_ID,
      cancelled: false,
      createdAt: 1_700_000_000_000,
    });
    mocks.getGroup.mockResolvedValue({ status: "completed" });
    mocks.getGroupNumericStats.mockResolvedValue({ completed: 1, active: 0 });
    mocks.getGroupJobs.mockResolvedValue([
      { id: "child-1", status: "completed", returnvalue: null },
    ]);

    const readMany = vi.fn(
      async (): Promise<Map<string, StoredJob>> =>
        new Map([["child-1", { state: "completed", document: externalDoc }]]),
    );
    const usage = vi.fn(async () => 12);
    const customStore: JobStoreModule = {
      ...queueJobStore(),
      storesResultsExternally: () => true,
      readMany,
      usage,
    };

    await withService(
      testService(defaultModules(), parts, { jobStore: customStore }),
      async () => {
        const out = makeRes();
        await crawlStatusController(
          {
            params: { jobId: JOB_ID },
            query: {},
            auth: { team_id: TEAM_ID },
            protocol: "http",
            host: "localhost",
          } as any,
          out.res,
        );

        expect(usage).toHaveBeenCalledWith(JOB_ID, { emptyAsZero: true });
        expect(readMany).toHaveBeenCalledWith(["child-1"], "scrape");
        expect(out.result().status).toBe(200);
        expect(out.result().body).toMatchObject({
          status: "completed",
          creditsUsed: 12,
          data: [externalDoc],
        });
      },
    );
  });

  it("merges jobStore.read with queue state in getJob and falls back to parallel read in getJobs", async () => {
    const externalDoc = {
      markdown: "from read",
      metadata: { statusCode: 200, proxyUsed: "basic" as const },
    };
    const read = vi.fn(
      async (): Promise<StoredJob | null> => ({
        state: "completed",
        document: externalDoc,
        completedAtMs: 1_700_000_005_000,
      }),
    );
    const customStore: JobStoreModule = {
      ...queueJobStore(),
      storesResultsExternally: () => true,
      read,
    };

    await withService(
      testService(defaultModules(), parts, { jobStore: customStore }),
      async () => {
        const single = await getJob(JOB_ID);
        expect(single).toEqual({
          id: JOB_ID,
          status: "completed",
          returnvalue: externalDoc,
          data: { scrapeOptions: null },
          timestamp: 1_700_000_005_000,
          failedReason: undefined,
        });

        mocks.getJobs.mockResolvedValueOnce([
          {
            id: "child-2",
            status: "completed",
            createdAt: new Date(1_700_000_000_000),
            data: { scrapeOptions: { formats: ["markdown"] } },
            returnvalue: null,
          },
        ]);
        const batch = await getJobs(["child-2"]);
        expect(batch).toEqual([
          {
            id: "child-2",
            status: "completed",
            returnvalue: externalDoc,
            data: { scrapeOptions: { formats: ["markdown"] } },
            timestamp: 1_700_000_000_000,
            failedReason: undefined,
          },
        ]);
      },
    );
  });

  it("rethrows jobStore.read failures when no queue job exists or external results are missing", async () => {
    const readError = new Error("store unavailable");
    const customStore: JobStoreModule = {
      ...queueJobStore(),
      storesResultsExternally: () => true,
      read: vi.fn().mockRejectedValue(readError),
    };

    await withService(
      testService(defaultModules(), parts, { jobStore: customStore }),
      async () => {
        mocks.getJob.mockResolvedValueOnce(null);
        await expect(getJob(JOB_ID)).rejects.toThrow("store unavailable");

        mocks.getJob.mockResolvedValueOnce({
          id: JOB_ID,
          status: "completed",
          createdAt: new Date(1_700_000_000_000),
          data: { mode: "single_urls", scrapeOptions: {} },
          returnvalue: null,
        });
        await expect(getJob(JOB_ID)).rejects.toThrow("store unavailable");
      },
    );
  });
});
