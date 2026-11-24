const { redisMock, insertValues, loggerMock } = vi.hoisted(() => ({
  redisMock: {
    lpop: vi.fn(),
    lpush: vi.fn(),
    llen: vi.fn(),
    rpush: vi.fn(),
  },
  insertValues: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../redis", () => ({ redisEvictConnection: redisMock }));
vi.mock("../../db/connection", () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
}));
vi.mock("../../db/schema", () => ({ webhook_logs: {} }));
vi.mock("./queue", () => ({ webhookQueue: { publish: vi.fn() } }));
vi.mock("../../config", () => ({ config: {} }));
vi.mock("../../lib/logger", () => ({ logger: loggerMock }));

import { processWebhookInsertJobs } from "./delivery";

const constraintError = () =>
  Object.assign(new Error("violates not-null constraint"), { code: "23502" });

const row = (n: number) =>
  JSON.stringify({ success: true, team_id: "t", crawl_id: `c${n}`, url: "u" });

describe("processWebhookInsertJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.lpush.mockReset();
    insertValues.mockReset();
    redisMock.llen.mockResolvedValue(0);
    insertValues.mockResolvedValue(undefined);
  });

  it("inserts the whole batch and does not requeue on success", async () => {
    redisMock.lpop.mockResolvedValue([row(1), row(2)]);
    await processWebhookInsertJobs();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0][0]).toHaveLength(2);
    expect(redisMock.lpush).not.toHaveBeenCalled();
  });

  it("does nothing when the queue is empty", async () => {
    redisMock.lpop.mockResolvedValue(null);
    await processWebhookInsertJobs();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("puts the batch back, in order, when the insert fails", async () => {
    redisMock.lpop.mockResolvedValue([row(1), row(2), row(3)]);
    insertValues.mockRejectedValueOnce(new Error("db down"));
    await processWebhookInsertJobs();
    expect(redisMock.lpush).toHaveBeenCalledTimes(1);
    // lpush adds to the head one by one, so the args are reversed to keep order
    expect(redisMock.lpush).toHaveBeenCalledWith(
      "webhook-insert-queue",
      row(3),
      row(2),
      row(1),
    );
  });

  it("skips a malformed entry and still inserts the rest", async () => {
    redisMock.lpop.mockResolvedValue([row(1), "{not json", row(2)]);
    await processWebhookInsertJobs();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0][0]).toHaveLength(2);
    expect(redisMock.lpush).not.toHaveBeenCalled();
  });

  it("does not requeue when the queue is already at its cap", async () => {
    redisMock.lpop.mockResolvedValue([row(1)]);
    redisMock.llen.mockResolvedValue(100_000);
    insertValues.mockRejectedValueOnce(new Error("db down"));
    await processWebhookInsertJobs();
    expect(redisMock.lpush).not.toHaveBeenCalled();
  });

  it("retries the requeue once, then gives up without throwing", async () => {
    redisMock.lpop.mockResolvedValue([row(1)]);
    insertValues.mockRejectedValueOnce(new Error("db down"));
    redisMock.lpush.mockRejectedValue(new Error("redis down"));
    await expect(processWebhookInsertJobs()).resolves.toBeUndefined();
    expect(redisMock.lpush).toHaveBeenCalledTimes(2);
  });

  it("recovers if the second requeue attempt works", async () => {
    redisMock.lpop.mockResolvedValue([row(1)]);
    insertValues.mockRejectedValueOnce(new Error("db down"));
    redisMock.lpush.mockRejectedValueOnce(new Error("blip"));
    redisMock.lpush.mockResolvedValueOnce(1);
    await processWebhookInsertJobs();
    expect(redisMock.lpush).toHaveBeenCalledTimes(2);
  });

  it("isolates a rejected row, drops only it and keeps the others", async () => {
    redisMock.lpop.mockResolvedValue([row(1), row(2), row(3)]);
    insertValues.mockRejectedValueOnce(constraintError()); // the batch
    insertValues.mockResolvedValueOnce(undefined); // row 1
    insertValues.mockRejectedValueOnce(constraintError()); // row 2
    insertValues.mockResolvedValueOnce(undefined); // row 3
    await processWebhookInsertJobs();
    expect(insertValues).toHaveBeenCalledTimes(4);
    expect(redisMock.lpush).not.toHaveBeenCalled();
  });

  it("drops a single rejected row instead of retrying it forever", async () => {
    redisMock.lpop.mockResolvedValue([row(1)]);
    insertValues.mockRejectedValue(constraintError());
    await processWebhookInsertJobs();
    expect(redisMock.lpush).not.toHaveBeenCalled();
  });

  it("requeues the failed row and the rest if the database drops mid-way", async () => {
    redisMock.lpop.mockResolvedValue([row(1), row(2), row(3)]);
    insertValues.mockRejectedValueOnce(constraintError()); // the batch
    insertValues.mockResolvedValueOnce(undefined); // row 1
    insertValues.mockRejectedValueOnce(new Error("connection reset")); // row 2
    await processWebhookInsertJobs();
    expect(insertValues).toHaveBeenCalledTimes(3);
    expect(redisMock.lpush).toHaveBeenCalledWith(
      "webhook-insert-queue",
      row(3),
      row(2),
    );
  });

  it("finds the SQLSTATE code on a wrapped error's cause", async () => {
    redisMock.lpop.mockResolvedValue([row(1)]);
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: { code: "22P02" },
    });
    insertValues.mockRejectedValue(wrapped);
    await processWebhookInsertJobs();
    expect(redisMock.lpush).not.toHaveBeenCalled();
  });

  it("treats a non-row database error as transient and requeues", async () => {
    redisMock.lpop.mockResolvedValue([row(1)]);
    insertValues.mockRejectedValueOnce(
      Object.assign(new Error("shutting down"), { code: "57P01" }),
    );
    await processWebhookInsertJobs();
    expect(redisMock.lpush).toHaveBeenCalledTimes(1);
  });
});
