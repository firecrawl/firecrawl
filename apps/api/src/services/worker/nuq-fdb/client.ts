import type * as FDBModule from "foundationdb";
import type { Database } from "foundationdb";
import { config } from "../../../config";

// The foundationdb package loads libfdb_c at require-time. Keep the require
// lazy so processes that never touch the FDB backend (PG-only deploys, unit
// tests, environments without the client library) can still boot.
let fdbModule: typeof FDBModule | null = null;

export function getFdb(): typeof FDBModule {
  if (fdbModule === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fdbModule = require("foundationdb") as typeof FDBModule;
    fdbModule.setAPIVersion(720);
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
      error => {
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
