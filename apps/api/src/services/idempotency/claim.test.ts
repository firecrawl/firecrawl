import type { Request } from "express";
import { v7 as uuidv7 } from "uuid";

vi.mock("../../db/connection", () => ({
  db: { transaction: vi.fn() },
}));

import { db } from "../../db/connection";
import { claimIdempotencyKey, InvalidIdempotencyKeyError } from "./claim";

function containsKey(chunk: any, key: string): boolean {
  if (chunk === key || chunk?.value === key) return true;
  if (Array.isArray(chunk)) return chunk.some(part => containsKey(part, key));
  return (
    chunk?.queryChunks?.some((part: any) => containsKey(part, key)) ?? false
  );
}

describe("claimIdempotencyKey", () => {
  const transaction = vi.mocked(db.transaction);

  beforeEach(() => {
    transaction.mockReset();
  });

  it("rejects malformed keys without touching the database", async () => {
    const req = {
      headers: { "x-idempotency-key": "not-a-uuid" },
    } as unknown as Request;
    await expect(claimIdempotencyKey(req)).rejects.toBeInstanceOf(
      InvalidIdempotencyKeyError,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("claims on the primary inside a locked transaction", async () => {
    const key = uuidv7();
    const calls: string[] = [];
    const tx: any = {
      execute: vi.fn(async (query: any) => {
        expect(
          query.queryChunks.some((chunk: any) =>
            String(chunk.value ?? "").includes("pg_advisory_xact_lock"),
          ),
        ).toBe(true);
        expect(containsKey(query, key)).toBe(true);
        calls.push("lock");
      }),
      select: vi.fn(() => ({
        from: () => ({
          where: (condition: any) => ({
            limit: async () => {
              expect(containsKey(condition, key)).toBe(true);
              calls.push("read");
              return [];
            },
          }),
        }),
      })),
      insert: vi.fn(() => ({
        values: async (row: any) => {
          expect(row.key).toBe(key);
          calls.push("insert");
        },
      })),
    };
    transaction.mockImplementation(async (callback: any) => callback(tx));

    const req = { headers: { "x-idempotency-key": key } } as unknown as Request;
    expect(await claimIdempotencyKey(req)).toBe(true);
    expect(calls).toEqual(["lock", "read", "insert"]);
  });

  it("does not insert when the key was already claimed", async () => {
    const key = uuidv7();
    const tx: any = {
      execute: vi.fn(async () => {}),
      select: () => ({
        from: () => ({
          where: (condition: any) => ({
            limit: async () => {
              expect(containsKey(condition, key)).toBe(true);
              return [{ key }];
            },
          }),
        }),
      }),
      insert: vi.fn(),
    };
    transaction.mockImplementation(async (callback: any) => callback(tx));

    const req = { headers: { "x-idempotency-key": key } } as unknown as Request;
    expect(await claimIdempotencyKey(req)).toBe(false);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("admits only one of two simultaneous claims for the same key", async () => {
    const key = uuidv7();
    const claimedKeys = new Set<string>();
    let lock = Promise.resolve();

    transaction.mockImplementation(async (callback: any) => {
      let unlock!: () => void;
      const tx: any = {
        execute: async () => {
          const previous = lock;
          lock = new Promise(resolve => {
            unlock = resolve;
          });
          await previous;
        },
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                const exists = claimedKeys.has(key);
                await Promise.resolve();
                return exists ? [{ key }] : [];
              },
            }),
          }),
        }),
        insert: () => ({
          values: async () => {
            claimedKeys.add(key);
          },
        }),
      };
      try {
        return await callback(tx);
      } finally {
        unlock?.();
      }
    });

    const req = { headers: { "x-idempotency-key": key } } as unknown as Request;
    const outcomes = await Promise.all([
      claimIdempotencyKey(req),
      claimIdempotencyKey(req),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(claimedKeys.size).toBe(1);
  });

  it("uses the same lock and database key for case variants of a UUID", async () => {
    const key = "abcdef12-3456-4789-abcd-abcdef123456";
    const observed: string[] = [];
    const tx: any = {
      execute: vi.fn(async (query: any) => {
        expect(containsKey(query, key)).toBe(true);
        observed.push(key);
      }),
      select: vi.fn(() => ({
        from: () => ({
          where: (condition: any) => ({
            limit: async () => {
              expect(containsKey(condition, key)).toBe(true);
              return [];
            },
          }),
        }),
      })),
      insert: vi.fn(() => ({
        values: async (row: any) => expect(row.key).toBe(key),
      })),
    };
    transaction.mockImplementation(async (callback: any) => callback(tx));

    for (const spelling of [key.toUpperCase(), key]) {
      const req = {
        headers: { "x-idempotency-key": spelling },
      } as unknown as Request;
      expect(await claimIdempotencyKey(req)).toBe(true);
    }
    expect(observed).toEqual([key, key]);
  });
});
