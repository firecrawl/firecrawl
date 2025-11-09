import { finalizeJobWithRetry } from "../job-finalizer";
import type { Logger } from "winston";

describe("finalizeJobWithRetry", () => {
  const logger = () =>
    ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }) as unknown as Logger;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("logs success on first attempt", async () => {
    const log = logger();
    const finalize = jest.fn().mockResolvedValue(true);

    await finalizeJobWithRetry("finish", finalize, "job-1", log, 3);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "NuQ job finalized",
      expect.objectContaining({ jobId: "job-1", action: "finish", attempt: 1 }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("retries until success", async () => {
    const log = logger();
    const finalize = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await finalizeJobWithRetry("fail", finalize, "job-2", log, 5);

    expect(finalize).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      "Failed to finalize job",
      expect.objectContaining({ jobId: "job-2", attempt: 1, action: "fail" }),
    );
    expect(log.info).toHaveBeenCalledWith(
      "NuQ job finalized",
      expect.objectContaining({ jobId: "job-2", attempt: 2 }),
    );
  });

  it("throws after max attempts", async () => {
    const log = logger();
    const finalize = jest.fn().mockResolvedValue(false);

    await expect(
      finalizeJobWithRetry("finish", finalize, "job-3", log, 2),
    ).rejects.toThrow("NuQ job finalize update affected 0 rows");

    expect(finalize).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      "Failed to finalize job after retries",
      expect.objectContaining({ jobId: "job-3" }),
    );
  });
});
