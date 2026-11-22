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

const row = (n: number) =>
  JSON.stringify({ success: true, team_id: "t", crawl_id: `c${n}`, url: "u" });

describe("processWebhookInsertJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("does not throw if requeueing itself fails", async () => {
    redisMock.lpop.mockResolvedValue([row(1)]);
    insertValues.mockRejectedValueOnce(new Error("db down"));
    redisMock.lpush.mockRejectedValueOnce(new Error("redis down"));
    await expect(processWebhookInsertJobs()).resolves.toBeUndefined();
  });

  it("drops a single poison row after repeated failures but keeps the others", async () => {
    const batch = [row(1), row(2), row(3)];
    redisMock.lpop.mockResolvedValue(batch);
    // 4 failed ticks get requeued
    insertValues.mockRejectedValue(new Error("bad row"));
    for (let i = 0; i < 4; i++) await processWebhookInsertJobs();
    expect(redisMock.lpush).toHaveBeenCalledTimes(4);

    // 5th tick: batch fails, then row-by-row; only row 2 is bad
    redisMock.lpush.mockClear();
    insertValues.mockReset();
    insertValues.mockRejectedValueOnce(new Error("bad row")); // the batch
    insertValues.mockResolvedValueOnce(undefined); // row 1
    insertValues.mockRejectedValueOnce(new Error("bad row")); // row 2
    insertValues.mockResolvedValueOnce(undefined); // row 3
    await processWebhookInsertJobs();
    expect(redisMock.lpush).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(4);
  });

  it("keeps the batch when every row fails, since that looks like an outage", async () => {
    // reach the failure threshold first (earlier tests leave the counter at 0
    // after a resolved isolation, so fail 4 times)
    redisMock.lpop.mockResolvedValue([row(1), row(2)]);
    insertValues.mockReset();
    insertValues.mockRejectedValue(new Error("db down"));
    for (let i = 0; i < 4; i++) await processWebhookInsertJobs();
    redisMock.lpush.mockClear();

    await processWebhookInsertJobs(); // 5th: batch + 2 single inserts all fail
    expect(redisMock.lpush).toHaveBeenCalledTimes(1);
    expect(redisMock.lpush).toHaveBeenCalledWith(
      "webhook-insert-queue",
      row(2),
      row(1),
    );
  });
});
