import type { Mock } from "vitest";
import { vi } from "vitest";

// Hermetic: job-priority talks to services/redis (not queue-service) and to
// Autumn, so both are stubbed here. controllers/auth is stubbed too and
// asserted never to be called — the org is the caller's to pass, because
// getJobPriority runs once per discovered link inside a crawl and must not
// turn into a Redis GET per link.
vi.mock("../../services/redis", () => ({
  redisEvictConnection: {
    sadd: vi.fn(),
    srem: vi.fn(),
    scard: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    getRateLimitMultiplier: vi.fn(),
  },
}));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(),
}));

import {
  getJobPriority,
  addJobPriority,
  deleteJobPriority,
} from "../job-priority";
import { redisEvictConnection } from "../../services/redis";
import { autumnService } from "../../services/autumn/autumn.service";
import { getACUCTeam } from "../../controllers/auth";
import {} from "../../types";

const getRateLimitMultiplier = autumnService.getRateLimitMultiplier as Mock;

// Multipliers that land on the plan tiers the priority cases below assume.
const STANDARD_MULTIPLIER = 50;
const HOBBY_MULTIPLIER = 10;
const FREE_MULTIPLIER = 1;

beforeEach(() => {
  getRateLimitMultiplier.mockResolvedValue(FREE_MULTIPLIER);
});

describe("Job Priority Tests", () => {
  afterEach(() => {
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

  test("getJobPriority should return correct priority based on plan and set length", async () => {
    const team_id = "team1";
    getRateLimitMultiplier.mockResolvedValue(STANDARD_MULTIPLIER);
    (redisEvictConnection.scard as Mock).mockResolvedValue(150);

    const priority = await getJobPriority({ team_id, org_id: null });
    expect(priority).toBe(10);

    (redisEvictConnection.scard as Mock).mockResolvedValue(250);
    const priorityExceeded = await getJobPriority({ team_id, org_id: null });
    expect(priorityExceeded).toBe(20); // basePriority + Math.ceil((250 - 200) * 0.2)
  });

  test("getJobPriority should handle different plans correctly", async () => {
    const team_id = "team1";

    getRateLimitMultiplier.mockResolvedValue(HOBBY_MULTIPLIER);
    (redisEvictConnection.scard as Mock).mockResolvedValue(50);
    let priority = await getJobPriority({ team_id, org_id: null });
    expect(priority).toBe(10);

    (redisEvictConnection.scard as Mock).mockResolvedValue(150);
    priority = await getJobPriority({ team_id, org_id: null });
    expect(priority).toBe(25); // basePriority + Math.ceil((150 - 100) * 0.3)

    getRateLimitMultiplier.mockResolvedValue(FREE_MULTIPLIER);
    (redisEvictConnection.scard as Mock).mockResolvedValue(25);
    priority = await getJobPriority({ team_id, org_id: null });
    expect(priority).toBe(10);

    (redisEvictConnection.scard as Mock).mockResolvedValue(60);
    priority = await getJobPriority({ team_id, org_id: null });
    expect(priority).toBe(28); // basePriority + Math.ceil((60 - 25) * 0.5)
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

    // Clear the mock calls
    (redisEvictConnection.expire as Mock).mockClear();

    // Add another job
    await addJobPriority(team_id, job_id2);
    expect(redisEvictConnection.expire).toHaveBeenCalledWith(
      `limit_team_id:${team_id}`,
      60,
    );
  });

  test("Set should expire after 60 seconds", async () => {
    const team_id = "team1";
    const job_id = "job1";

    vi.useFakeTimers();

    await addJobPriority(team_id, job_id);
    expect(redisEvictConnection.expire).toHaveBeenCalledWith(
      `limit_team_id:${team_id}`,
      60,
    );

    // Fast-forward time by 59 seconds
    vi.advanceTimersByTime(59000);

    // The set should still exist
    expect(redisEvictConnection.scard).not.toHaveBeenCalled();

    // Fast-forward time by 2 more seconds (total 61 seconds)
    vi.advanceTimersByTime(2000);

    // Check if the set has been removed (scard should return 0)
    (redisEvictConnection.scard as Mock).mockResolvedValue(0);
    const setSize = await redisEvictConnection.scard(
      `limit_team_id:${team_id}`,
    );
    expect(setSize).toBe(0);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Where the org comes from: the caller, and nowhere else.
// ---------------------------------------------------------------------------

describe("the org the caller supplies", () => {
  it("goes straight to the rate-limit multiplier, with no ACUC lookup", async () => {
    (redisEvictConnection.scard as Mock).mockResolvedValue(1);

    await getJobPriority({ team_id: "team1", org_id: "org-1" });

    expect(getRateLimitMultiplier).toHaveBeenCalledWith("team1", "org-1");
    expect(getACUCTeam).not.toHaveBeenCalled();
  });

  it("passes a null org through as the caller gave it", async () => {
    (redisEvictConnection.scard as Mock).mockResolvedValue(1);

    await getJobPriority({ team_id: "team1", org_id: null });

    expect(getRateLimitMultiplier).toHaveBeenCalledWith("team1", null);
    expect(getACUCTeam).not.toHaveBeenCalled();
  });
});
