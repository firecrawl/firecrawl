const { addExtractJobMock, updateExtractMock, loggerMock } = vi.hoisted(() => ({
  addExtractJobMock: vi.fn(),
  updateExtractMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("bullmq", () => ({ Queue: vi.fn() }));
vi.mock("ioredis", () => ({ default: vi.fn() }));
vi.mock("./extract-queue", () => ({ addExtractJob: addExtractJobMock }));
vi.mock("../lib/extract/extract-redis", () => ({
  updateExtract: updateExtractMock,
}));
vi.mock("../config", () => ({ config: {} }));
vi.mock("../lib/logger", () => ({ logger: loggerMock }));

const job = {
  extractId: "extract-1",
  request: { urls: ["https://example.com"] },
  teamId: "team-1",
  createdAt: 1,
};

describe("extract queue service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addExtractJobMock.mockResolvedValue(undefined);
    updateExtractMock.mockResolvedValue(undefined);
  });

  it("does not change a successfully enqueued extract", async () => {
    const { addExtractJobToQueue } = await import("./queue-service.js");
    await addExtractJobToQueue(job.extractId, job);
    expect(addExtractJobMock).toHaveBeenCalledWith(job.extractId, job);
    expect(updateExtractMock).not.toHaveBeenCalled();
  });

  it("marks a rejected publish failed and preserves the publish error", async () => {
    const publishError = new Error("broker rejected");
    addExtractJobMock.mockRejectedValue(publishError);
    const { addExtractJobToQueue } = await import("./queue-service.js");

    await expect(addExtractJobToQueue(job.extractId, job)).rejects.toBe(
      publishError,
    );
    expect(updateExtractMock).toHaveBeenCalledWith(job.extractId, {
      status: "failed",
      error: "Failed to enqueue extract job",
    });
  });

  it("still reports the publish failure when updating the status fails", async () => {
    const publishError = new Error("broker rejected");
    addExtractJobMock.mockRejectedValue(publishError);
    updateExtractMock.mockRejectedValue(new Error("Redis down"));
    const { addExtractJobToQueue } = await import("./queue-service.js");

    await expect(addExtractJobToQueue(job.extractId, job)).rejects.toBe(
      publishError,
    );
    expect(loggerMock.error).toHaveBeenCalledWith(
      "Failed to mark unqueued extract as failed",
      expect.objectContaining({ extractId: job.extractId }),
    );
  });
});
