import type { Job } from "bullmq";
import type { ChangeTrackingPurgeJobData } from "./queue-service";

const { limit, addBulk, changeTrackingDeleteTeam, mockConfig } = vi.hoisted(
  () => ({
    limit: vi.fn(),
    addBulk: vi.fn(),
    changeTrackingDeleteTeam: vi.fn(),
    mockConfig: {} as {
      USE_DB_AUTHENTICATION?: boolean;
      BIGTABLE_INSTANCE_ID?: string;
    },
  }),
);

vi.mock("../config", () => ({ config: mockConfig }));
vi.mock("../db/connection", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
  },
}));
vi.mock("../lib/change-tracking-store", () => ({ changeTrackingDeleteTeam }));
vi.mock("./queue-service", () => ({
  getChangeTrackingPurgeQueue: () => ({ addBulk }),
}));
vi.mock("../lib/logger", () => {
  const logger: any = {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger };
});

import {
  changeTrackingPurgeConfigured,
  enqueueChangeTrackingPurge,
  processChangeTrackingPurge,
} from "./change-tracking-purge";

const TEAM_ID = "00000000-0000-4000-8000-000000000001";

function job(attemptsMade = 0): Job<ChangeTrackingPurgeJobData> {
  return {
    id: "1",
    data: { teamId: TEAM_ID },
    attemptsMade,
    opts: { attempts: 12 },
  } as Job<ChangeTrackingPurgeJobData>;
}

describe("change tracking purge", () => {
  beforeEach(() => {
    limit.mockReset();
    addBulk.mockReset();
    changeTrackingDeleteTeam.mockReset();
  });

  it("is configured only with database auth and Bigtable", () => {
    mockConfig.USE_DB_AUTHENTICATION = true;
    mockConfig.BIGTABLE_INSTANCE_ID = undefined;
    expect(changeTrackingPurgeConfigured()).toBe(false);

    mockConfig.BIGTABLE_INSTANCE_ID = "instance";
    expect(changeTrackingPurgeConfigured()).toBe(true);

    mockConfig.USE_DB_AUTHENTICATION = false;
    expect(changeTrackingPurgeConfigured()).toBe(false);
  });

  it("schedules a pass after deletion and a pass for late writes", async () => {
    addBulk.mockResolvedValueOnce([]);

    await enqueueChangeTrackingPurge(TEAM_ID);

    const [jobs] = addBulk.mock.calls[0];
    expect(jobs.map((j: any) => j.opts.delay)).toEqual([
      30 * 1000,
      25 * 60 * 60 * 1000,
    ]);
    for (const j of jobs) {
      expect(j.data).toEqual({ teamId: TEAM_ID });
      expect(j.opts.attempts).toBe(12);
      expect(j.opts.backoff).toEqual({ type: "exponential", delay: 60 * 1000 });
    }
    expect(jobs.map((j: any) => j.opts.deduplication)).toEqual([
      { id: `change-tracking-purge:${TEAM_ID}:0` },
      { id: `change-tracking-purge:${TEAM_ID}:1` },
    ]);
  });

  it("purges the rows once the team row is gone", async () => {
    limit.mockResolvedValueOnce([]);
    changeTrackingDeleteTeam.mockResolvedValueOnce(42);

    await expect(processChangeTrackingPurge(job())).resolves.toBeUndefined();
    expect(changeTrackingDeleteTeam).toHaveBeenCalledWith(TEAM_ID);
  });

  it("keeps the rows and fails the attempt while the team still exists", async () => {
    limit.mockResolvedValueOnce([{ id: TEAM_ID }]);

    await expect(processChangeTrackingPurge(job())).rejects.toThrow(
      "Team still exists",
    );
    expect(changeTrackingDeleteTeam).not.toHaveBeenCalled();
  });

  it("fails the attempt when the purge fails, so the queue retries it", async () => {
    limit.mockResolvedValueOnce([]);
    changeTrackingDeleteTeam.mockRejectedValueOnce(new Error("unavailable"));

    await expect(processChangeTrackingPurge(job(11))).rejects.toThrow(
      "unavailable",
    );
  });
});
