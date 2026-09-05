import { checkedRedisExec, isRedlockContention } from "./redis-errors";
import { ExecutionError, ResourceLockedError } from "redlock";

describe("checkedRedisExec", () => {
  it("preserves successful and empty pipeline replies", async () => {
    const results: [Error | null, unknown][] = [
      [null, 0],
      [null, "OK"],
    ];
    expect(await checkedRedisExec(Promise.resolve(results), "test")).toBe(
      results,
    );
    expect(await checkedRedisExec(Promise.resolve([]), "test")).toEqual([]);
  });

  it("throws the original command error even when adjacent commands succeeded", async () => {
    const error = new Error("WRONGTYPE detailed command failure");
    await expect(
      checkedRedisExec(
        Promise.resolve([
          [null, 1],
          [error, null],
          [null, 1],
        ]),
        "test",
      ),
    ).rejects.toBe(error);
  });

  it("rejects aborted transactions and preserves original transport errors", async () => {
    await expect(
      checkedRedisExec(Promise.resolve(null), "test"),
    ).rejects.toThrow("no results");
    const error = new Error("connection failed with original details");
    await expect(checkedRedisExec(Promise.reject(error), "test")).rejects.toBe(
      error,
    );
  });

  it("distinguishes lock contention from command and mixed lock failures", async () => {
    const failure = (...errors: Error[]) =>
      new ExecutionError("lock failed", [
        Promise.resolve({
          membershipSize: errors.length,
          quorumSize: 1,
          votesFor: new Set(),
          votesAgainst: new Map(errors.map(error => [{} as any, error])),
        }),
      ]);
    expect(
      await isRedlockContention(failure(new ResourceLockedError("locked"))),
    ).toBe(true);
    expect(await isRedlockContention(failure(new Error("NOPERM")))).toBe(false);
    expect(
      await isRedlockContention(
        failure(new ResourceLockedError("locked"), new Error("OOM")),
      ),
    ).toBe(false);
    expect(await isRedlockContention(new Error("connection failed"))).toBe(
      false,
    );
  });
});
