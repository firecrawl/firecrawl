import type { Database, open, setAPIVersion, tuple } from "foundationdb";
import { config } from "../../../config";
import { isJsonObject } from "../../../lib/json-types";

interface FdbClientModule {
  setAPIVersion: typeof setAPIVersion;
  open: typeof open;
  tuple: typeof tuple;
}

function isFdbClientModule(value: unknown): value is FdbClientModule {
  return (
    isJsonObject(value) &&
    typeof value.setAPIVersion === "function" &&
    typeof value.open === "function" &&
    isJsonObject(value.tuple) &&
    typeof value.tuple.pack === "function" &&
    typeof value.tuple.unpack === "function" &&
    typeof value.tuple.range === "function"
  );
}

// The foundationdb package loads libfdb_c at require-time. Keep the require
// lazy so processes that never touch the FDB backend (PG-only deploys, unit
// tests, environments without the client library) can still boot.
let fdbModule: FdbClientModule | null = null;

export function getFdb(): FdbClientModule {
  if (fdbModule === null) {
    const loaded: unknown = require("foundationdb");
    if (!isFdbClientModule(loaded)) {
      throw new Error("Failed to load foundationdb module");
    }
    loaded.setAPIVersion(720);
    fdbModule = loaded;
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
