import type { EventEmitter } from "node:events";
import Redlock from "redlock";
import { config } from "../config";
import { isJsonObject } from "../lib/json-types";
import Client from "ioredis";

interface RedlockSettings {
  readonly driftFactor: number;
  readonly retryCount: number;
  readonly retryDelay: number;
  readonly retryJitter: number;
  readonly automaticExtensionThreshold: number;
}

type RedlockAbortSignal = AbortSignal & {
  error?: Error;
};

interface RedlockExecutionStats {
  readonly membershipSize: number;
  readonly quorumSize: number;
  readonly votesFor: Set<Client>;
  readonly votesAgainst: Map<Client, Error>;
}

interface RedlockExecutionResult {
  attempts: ReadonlyArray<Promise<RedlockExecutionStats>>;
}

interface RedlockLock {
  readonly redlock: RedlockInstance;
  readonly resources: Array<string>;
  readonly value: string;
  readonly attempts: ReadonlyArray<Promise<RedlockExecutionStats>>;
  expiration: number;
  release(): Promise<RedlockExecutionResult>;
  extend(duration: number): Promise<RedlockLock>;
}

interface RedlockInstance extends EventEmitter {
  readonly clients: Set<Client>;
  readonly settings: RedlockSettings;
  quit(): Promise<void>;
  acquire(
    resources: Array<string>,
    duration: number,
    settings?: Partial<RedlockSettings>,
  ): Promise<RedlockLock>;
  release(
    lock: RedlockLock,
    settings?: Partial<RedlockSettings>,
  ): Promise<RedlockExecutionResult>;
  extend(
    existing: RedlockLock,
    duration: number,
    settings?: Partial<RedlockSettings>,
  ): Promise<RedlockLock>;
  using<T>(
    resources: Array<string>,
    duration: number,
    settings: Partial<RedlockSettings>,
    routine?: (signal: RedlockAbortSignal) => Promise<T>,
  ): Promise<T>;
  using<T>(
    resources: Array<string>,
    duration: number,
    routine: (signal: RedlockAbortSignal) => Promise<T>,
  ): Promise<T>;
}

interface RedlockConstructor {
  new (
    clients: Iterable<Client>,
    settings?: Partial<RedlockSettings>,
  ): RedlockInstance;
}

function isRedlockConstructor(value: unknown): value is RedlockConstructor {
  if (typeof value !== "function") {
    return false;
  }
  const proto: unknown = value.prototype;
  return (
    isJsonObject(proto) &&
    typeof proto.using === "function" &&
    typeof proto.acquire === "function"
  );
}

function resolveRedlockConstructor(value: unknown): RedlockConstructor {
  if (!isRedlockConstructor(value)) {
    throw new Error("Failed to load Redlock constructor");
  }
  return value;
}

const RedlockCtor = resolveRedlockConstructor(Redlock);

const redisClient = config.REDIS_RATE_LIMIT_URL
  ? new Client(config.REDIS_RATE_LIMIT_URL, { lazyConnect: true })
  : new Client({ lazyConnect: true });

export const redlock: RedlockInstance = new RedlockCtor(
  // You should have one client for each independent redis node
  // or cluster.
  [redisClient],
  {
    // The expected clock drift; for more details see:
    // http://redis.io/topics/distlock
    driftFactor: 0.01, // multiplied by lock ttl to determine drift time

    retryCount: 200,

    retryDelay: 100,

    // the max time in ms randomly added to retries
    // to improve performance under high contention
    // see https://www.awsarchitectureblog.com/2015/03/backoff.html
    retryJitter: 200, // time in ms

    // The minimum remaining time on a lock before an extension is automatically
    // attempted with the `using` API.
    automaticExtensionThreshold: 500, // time in ms
  },
);
