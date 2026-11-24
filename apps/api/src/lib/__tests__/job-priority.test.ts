import type { Mock } from "vitest";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../services/redis", () => ({
  redisEvictConnection: {
    sadd: vi.fn(),
    srem: vi.fn(),
    scard: vi.fn(),
    expire: vi.fn(),
  },
}));

import {
  addJobPriority,
  deleteJobPriority,
  getJobPriority,
  getJobPriorityActiveCount,
} from "../job-priority";
import { redisEvictConnection } from "../../services/redis";
import { defaultModules, noLimits } from "../../service/defaults";
import { replaceService, type CoreParts } from "../../service/service";
import { testService, withService } from "../../service/testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

describe("Job Priority Tests", () => {
  afterEach(() => {
    replaceService(undefined);
    vi.clearAllMocks();
  });

  test("addJobPriority should add job_id to the set and set expiration", async () => {
    const team_id = "team1";
    const job_id = "job1";
    await addJobPriority(team_id, job_id);
    expect(redisEvictConnection.sadd).toHaveBeenCalledWith(
      `limit_team_id:${team_id}`,
      job_id,
    );
    expect(redisEvictConnection.expire).toHaveBeenCalledWith(
      `limit_team_id:${team_id}`,
      60,
    );
  });

  test("deleteJobPriority should remove job_id from the set", async () => {
    const team_id = "team1";
    const job_id = "job1";
    await deleteJobPriority(team_id, job_id);
    expect(redisEvictConnection.srem).toHaveBeenCalledWith(
      `limit_team_id:${team_id}`,
      job_id,
    );
  });

  test("getJobPriorityActiveCount reads the Redis set cardinality", async () => {
    (redisEvictConnection.scard as Mock).mockResolvedValue(42);
    await expect(getJobPriorityActiveCount("team1")).resolves.toBe(42);
    expect(redisEvictConnection.scard).toHaveBeenCalledWith(
      "limit_team_id:team1",
    );
  });

  test("addJobPriority should reset expiration time when adding new job", async () => {
    const team_id = "team1";
    const job_id1 = "job1";
    const job_id2 = "job2";

    await addJobPriority(team_id, job_id1);
    expect(redisEvictConnection.expire).toHaveBeenCalledWith(
      `limit_team_id:${team_id}`,
      60,
    );

    await addJobPriority(team_id, job_id2);
    expect(redisEvictConnection.expire).toHaveBeenCalledTimes(2);
    expect(redisEvictConnection.expire).toHaveBeenLastCalledWith(
      `limit_team_id:${team_id}`,
      60,
    );
  });

  test("getJobPriority returns basePriority with default noLimits", async () => {
    await expect(getJobPriority({ team_id: "team1" })).resolves.toBe(10);
    await expect(
      getJobPriority({ team_id: "team1", basePriority: 21 }),
    ).resolves.toBe(21);
  });

  test("getJobPriority delegates to the installed limits module with request context", async () => {
    const jobPriority = vi.fn().mockResolvedValue(28);
    await withService(
      testService(defaultModules(), parts, {
        limits: {
          ...noLimits(),
          jobPriority,
        },
      }),
      async () => {
        const result = await getJobPriority({
          team_id: "team1",
          acuc: {
            team_id: "team1",
            org_id: "org1",
            api_key_id: 99,
            concurrency_limit: 50,
            rate_limit_multiplier: 10,
            flags: { nuqFdb: true },
          } as never,
          basePriority: 15,
        });

        expect(result).toBe(28);
        expect(jobPriority).toHaveBeenCalledWith({
          ctx: {
            teamId: "team1",
            zeroDataRetention: false,
            flags: { nuqFdb: true },
            orgId: "org1",
            apiKeyId: 99,
            billing: undefined,
            concurrencyLimit: 50,
            rateLimitMultiplier: 10,
          },
          base: 15,
        });
      },
    );
  });
});
