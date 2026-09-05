import {
  checkedRedisExec,
  redisErrorDetails,
  isRedlockContention,
} from "./redis-errors";
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

  it("rejects a failed command even when adjacent commands succeeded", async () => {
    await expect(
      checkedRedisExec(
        Promise.resolve([
          [null, 1],
          [new Error("WRONGTYPE private-key"), null],
          [null, 1],
        ]),
        "test",
      ),
    ).rejects.toThrow("test: command 1 failed (WRONGTYPE)");
  });

  it("rejects aborted transactions and transport errors without exposing payloads", async () => {
    await expect(
      checkedRedisExec(Promise.resolve(null), "test"),
    ).rejects.toThrow("no results");
    await expect(
      checkedRedisExec(Promise.reject(new Error("secret payload")), "test"),
    ).rejects.toThrow("test: execution failed (unknown)");
    expect(
      JSON.stringify(
        redisErrorDetails(
          Object.assign(new Error("WRONGTYPE private-key"), {
            command: { args: ["secret"] },
          }),
        ),
      ),
    ).not.toContain("secret");
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
