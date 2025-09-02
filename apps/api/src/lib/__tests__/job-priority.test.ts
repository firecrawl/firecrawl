import {
  getJobPriority,
  addJobPriority,
  deleteJobPriority,
} from "../job-priority";
import { redisEvictConnection } from "../../services/redis";
import {} from "../../types";

jest.mock("../../services/queue-service", () => ({
  redisConnection: {
    sadd: jest.fn(),
    srem: jest.fn(),
    scard: jest.fn(),
    expire: jest.fn(),
  },
}));

describe("Job Priority Tests", () => {
  afterEach(() => {
    jest.clearAllMocks();
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
    const plan = "standard";
    (redisEvictConnection.scard as jest.Mock).mockResolvedValue(150);

    const priority = await getJobPriority({ team_id });
    expect(priority).toBe(10);

    (redisEvictConnection.scard as jest.Mock).mockResolvedValue(250);
    const priorityExceeded = await getJobPriority({ team_id });
    expect(priorityExceeded).toBe(20); // basePriority + Math.ceil((250 - 200) * 0.4)
  });

  test("getJobPriority should handle different plans correctly", async () => {
    const team_id = "team1";

    (redisEvictConnection.scard as jest.Mock).mockResolvedValue(50);
    let plan = "hobby";
    let priority = await getJobPriority({ team_id });
    expect(priority).toBe(10);

    (redisEvictConnection.scard as jest.Mock).mockResolvedValue(150);
    plan = "hobby";
    priority = await getJobPriority({ team_id });
    expect(priority).toBe(25); // basePriority + Math.ceil((150 - 50) * 0.3)

    (redisEvictConnection.scard as jest.Mock).mockResolvedValue(25);
    plan = "free";
    priority = await getJobPriority({ team_id });
    expect(priority).toBe(10);

    (redisEvictConnection.scard as jest.Mock).mockResolvedValue(60);
    plan = "free";
    priority = await getJobPriority({ team_id });
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
    (redisEvictConnection.expire as jest.Mock).mockClear();

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

    jest.useFakeTimers();

    await addJobPriority(team_id, job_id);
    expect(redisEvictConnection.expire).toHaveBeenCalledWith(
      `limit_team_id:${team_id}`,
      60,
    );

    // Fast-forward time by 59 seconds
    jest.advanceTimersByTime(59000);

    // The set should still exist
    expect(redisEvictConnection.scard).not.toHaveBeenCalled();

    // Fast-forward time by 2 more seconds (total 61 seconds)
    jest.advanceTimersByTime(2000);

    // Check if the set has been removed (scard should return 0)
    (redisEvictConnection.scard as jest.Mock).mockResolvedValue(0);
    const setSize = await redisEvictConnection.scard(
      `limit_team_id:${team_id}`,
    );
    expect(setSize).toBe(0);

    jest.useRealTimers();
  });
});
