import type { Database, open, setAPIVersion, tuple } from "foundationdb";
import { z } from "zod";
import { config } from "../../../config";

interface FdbClientModule {
  setAPIVersion: typeof setAPIVersion;
  open: typeof open;
  tuple: typeof tuple;
}

const fdbClientModuleShapeSchema = z.object({
  setAPIVersion: z.function(),
  open: z.function(),
  tuple: z.object({
    pack: z.function(),
    unpack: z.function(),
    range: z.function(),
  }),
});

const fdbClientModuleSchema = z.custom<FdbClientModule>(
  value => fdbClientModuleShapeSchema.safeParse(value).success,
);

// The foundationdb package loads libfdb_c at require-time. Keep the require
// lazy so processes that never touch the FDB backend (PG-only deploys, unit
// tests, environments without the client library) can still boot.
let fdbModule: FdbClientModule | null = null;

export function getFdb(): FdbClientModule {
  if (fdbModule === null) {
    const loaded: unknown = require("foundationdb");
    const parsed = fdbClientModuleSchema.safeParse(loaded);
    if (!parsed.success) {
      throw new Error("Failed to load foundationdb module");
    }
    parsed.data.setAPIVersion(720);
    fdbModule = parsed.data;
  }
  return fdbModule;
}

let db: Database | null = null;
let lastHealthCheck:
  | { checkedAt: number; timeoutMs: number; ok: boolean }
  | undefined;

export function getNuqFdbDatabase(): Database {
  if (db === null) {
    db = getFdb().open(config.FDB_CLUSTER_FILE);
  }
  return db;
}

export function isFdbConfigured(): boolean {
  return !!config.FDB_CLUSTER_FILE || config.NUQ_BACKEND === "fdb";
}

function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`FDB operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function withFdbTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return timeout(promise, timeoutMs);
}

export async function nuqFdbHealthCheck(timeoutMs = 1000): Promise<boolean> {
  const now = Date.now();
  if (
    lastHealthCheck &&
    lastHealthCheck.timeoutMs === timeoutMs &&
    now - lastHealthCheck.checkedAt < 5000
  ) {
    return lastHealthCheck.ok;
  }

  try {
    await timeout(
      getNuqFdbDatabase().doTn(async tn => {
        await tn.getReadVersion();
      }),
      timeoutMs,
    );
    lastHealthCheck = { checkedAt: now, timeoutMs, ok: true };
    return true;
  } catch {
    lastHealthCheck = { checkedAt: now, timeoutMs, ok: false };
    return false;
  }
}
