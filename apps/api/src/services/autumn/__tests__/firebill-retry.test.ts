import { beforeEach, describe, expect, it, vi } from "vitest";

const { queue } = vi.hoisted(() => ({
  queue: {
    add: vi.fn(async (..._args: unknown[]) => ({})),
    getJobCounts: vi.fn(async (..._args: unknown[]) => ({ waiting: 0 })),
  },
}));
vi.mock("../../queue-service", () => ({
  getFirebillTrackRetryQueue: () => queue,
}));
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { UnrecoverableError } from "bullmq";
import {
  MAX_BACKLOG,
  MAX_RETRY_AGE_MS,
  handOffTrack,
  resetBacklogForTest,
  processFirebillTrackRetryJob,
  retryJobId,
} from "../firebill-retry";
import { firebillTrackRetryTotal } from "../metrics";
import { logger } from "../../../lib/logger";

const params = {
  customerId: "org-1",
  entityId: "team-1",
  featureId: "CREDITS",
  value: 3,
  properties: {},
  idempotencyKey: "fc:track:scrape:job-1",
};

const outcomes = async () =>
  Object.fromEntries(
    (await firebillTrackRetryTotal.get()).values.map(v => [
      v.labels.outcome,
      v.value,
    ]),
  );

/** The slice of a BullMQ job the processor touches. */
const job = (attemptsMade: number, attempts = 10, ageMs = 1000) =>
  ({
    data: { path: "/v1/track", params },
    attemptsMade,
    opts: { attempts },
    timestamp: Date.now() - ageMs,
    moveToCompleted: vi.fn(async () => {}),
    moveToFailed: vi.fn(async () => {}),
  }) as any;

beforeEach(() => {
  queue.add.mockReset();
  queue.add.mockImplementation(async () => ({}));
  resetBacklogForTest();
  firebillTrackRetryTotal.reset();
  vi.mocked(logger.error).mockClear();
});

describe("handOffTrack", () => {
  it("queues the event under its idempotency key, delayed", async () => {
    await expect(handOffTrack("/v1/track", params)).resolves.toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      "track",
      { path: "/v1/track", params },
      { jobId: retryJobId(params.idempotencyKey), delay: 5000 },
    );
    expect(await outcomes()).toEqual({ queued: 1 });
  });

  it("refuses a handoff once the backlog is full", async () => {
    resetBacklogForTest(MAX_BACKLOG);
    await expect(handOffTrack("/v1/track", params)).resolves.toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(await outcomes()).toEqual({ queue_full: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("learns the backlog in the background, never on the caller's path", async () => {
    queue.getJobCounts.mockImplementation(async () => ({
      waiting: MAX_BACKLOG,
    }));
    // First handoff queues on the last known (empty) backlog and starts a refresh.
    await expect(handOffTrack("/v1/track", params)).resolves.toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    await expect(handOffTrack("/v1/track", params)).resolves.toBe(false);
    expect(await outcomes()).toEqual({ queued: 1, queue_full: 1 });
  });

  it("reports false and logs when the queue rejects", async () => {
    queue.add.mockRejectedValue(new Error("redis down"));
    await expect(handOffTrack("/v1/track", params)).resolves.toBe(false);
    expect(await outcomes()).toEqual({ queue_failed: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("uses a deterministic job id with no BullMQ key separator", () => {
    expect(retryJobId(params.idempotencyKey)).not.toContain(":");
    expect(retryJobId(params.idempotencyKey)).toBe(
      retryJobId(params.idempotencyKey),
    );
  });

  it("bounds the caller's wait, then records the late outcome", async () => {
    let land!: () => void;
    queue.add.mockImplementation(
      () => new Promise(resolve => (land = () => resolve({}))),
    );
    const started = Date.now();
    await expect(handOffTrack("/v1/track", params)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    // Slow is not lost: no "will not be billed" yet.
    expect(await outcomes()).toEqual({ queue_slow: 1 });
    expect(logger.error).not.toHaveBeenCalled();

    land();
    await new Promise(resolve => setImmediate(resolve));
    expect(await outcomes()).toEqual({ queue_slow: 1, queued: 1 });
  });

  it("reports a slow add that finally fails as lost", async () => {
    let fail!: () => void;
    queue.add.mockImplementation(
      () => new Promise((_, reject) => (fail = () => reject(new Error("x")))),
    );
    await handOffTrack("/v1/track", params);
    fail();
    await new Promise(resolve => setImmediate(resolve));
    expect(await outcomes()).toEqual({ queue_slow: 1, queue_failed: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("processFirebillTrackRetryJob", () => {
  it("completes the job once firebill accepts the event", async () => {
    const j = job(0);
    const attempt = vi.fn(async () => ({ ok: true }));
    await processFirebillTrackRetryJob("token", j, attempt);
    expect(attempt).toHaveBeenCalledWith("/v1/track", params);
    expect(j.moveToCompleted).toHaveBeenCalledWith(
      { success: true },
      "token",
      false,
    );
    expect(j.moveToFailed).not.toHaveBeenCalled();
    expect(await outcomes()).toEqual({ recovered: 1 });
  });

  it("hands a failed attempt back to BullMQ to retry", async () => {
    const j = job(3);
    await processFirebillTrackRetryJob("token", j, async () => ({ ok: false }));
    expect(j.moveToFailed).toHaveBeenCalledWith(
      expect.any(Error),
      "token",
      false,
    );
    expect(await outcomes()).toEqual({ retrying: 1 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("treats a thrown attempt as a failed one", async () => {
    const j = job(0);
    await processFirebillTrackRetryJob("token", j, async () => {
      throw new Error("boom");
    });
    expect(j.moveToFailed).toHaveBeenCalled();
    expect(await outcomes()).toEqual({ retrying: 1 });
  });

  it("logs the usage as lost on the last attempt", async () => {
    const j = job(9, 10);
    await processFirebillTrackRetryJob("token", j, async () => ({ ok: false }));
    expect(j.moveToFailed).toHaveBeenCalled();
    expect(await outcomes()).toEqual({ expired: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed completion escape the worker loop", async () => {
    const j = job(0);
    j.moveToCompleted.mockRejectedValue(new Error("lock lost"));
    await expect(
      processFirebillTrackRetryJob("token", j, async () => ({ ok: true })),
    ).resolves.toBeUndefined();
    expect(await outcomes()).toEqual({ recovered: 1 });
  });

  it("does not let a failed reschedule escape the worker loop", async () => {
    const j = job(3);
    j.moveToFailed.mockRejectedValue(new Error("lock lost"));
    await expect(
      processFirebillTrackRetryJob("token", j, async () => ({ ok: false })),
    ).resolves.toBeUndefined();
    expect(await outcomes()).toEqual({});
  });

  it("stops retrying a job older than the dedupe window, without sending it", async () => {
    const j = job(2, 10, MAX_RETRY_AGE_MS + 1);
    const attempt = vi.fn(async () => ({ ok: true }));
    await processFirebillTrackRetryJob("token", j, attempt);
    expect(attempt).not.toHaveBeenCalled();
    expect(j.moveToFailed).toHaveBeenCalledWith(
      expect.any(UnrecoverableError),
      "token",
      false,
    );
    expect(await outcomes()).toEqual({ expired: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
