import { EventEmitter } from "node:events";
import { Pool, type PoolConfig } from "pg";
import {
  keepPoolWarm,
  MAX_LIFETIME_MIN_SECONDS,
  MAX_LIFETIME_SPREAD_SECONDS,
  pickMaxLifetimeSeconds,
  resolveDbPoolOptions,
  type DbPoolName,
  type DbPoolProfile,
} from "./pool-profiles";

const POOLS: DbPoolName[] = ["main", "replica", "index"];
const PROFILES: DbPoolProfile[] = ["api", "worker", "utility"];

describe("resolveDbPoolOptions", () => {
  it("keeps the historical settings when no profile is set", () => {
    expect(resolveDbPoolOptions(undefined, "main", 4000)).toEqual({
      max: 20,
      min: 0,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 0,
      maxLifetimeSeconds: 0,
      keepAliveInitialDelayMillis: undefined,
    });
    expect(resolveDbPoolOptions(undefined, "replica", 4000).max).toBe(20);
    expect(resolveDbPoolOptions(undefined, "index", 4000).max).toBe(6);
  });

  it("resolves to the same effective pg-pool options as the previous hard-coded config", () => {
    const before = new Pool({
      max: 20,
      min: 0,
      keepAlive: true,
      Client: StubClient,
    } as unknown as PoolConfig).options;
    const after = new Pool({
      ...resolveDbPoolOptions(undefined, "main", 4000),
      keepAlive: true,
      Client: StubClient,
    } as unknown as PoolConfig).options;
    expect(after.max).toBe(before.max);
    expect(after.min).toBe(before.min);
    expect(after.idleTimeoutMillis).toBe(before.idleTimeoutMillis);
    expect(after.maxLifetimeSeconds).toBe(before.maxLifetimeSeconds);
    // pg-pool only ever truthiness-checks the connect timeout.
    expect(Boolean(after.connectionTimeoutMillis)).toBe(
      Boolean(before.connectionTimeoutMillis),
    );
  });

  it("api profile keeps every connection warm and bounds waits", () => {
    for (const pool of POOLS) {
      const options = resolveDbPoolOptions("api", pool, 20_000);
      expect(options.min).toBe(options.max);
      expect(options.connectionTimeoutMillis).toBe(15_000);
      expect(options.maxLifetimeSeconds).toBe(20_000);
      expect(options.keepAliveInitialDelayMillis).toBe(30_000);
      expect(options.idleTimeoutMillis).toBe(600_000);
    }
    expect(resolveDbPoolOptions("api", "main", 1).max).toBe(20);
    expect(resolveDbPoolOptions("api", "index", 1).max).toBe(6);
  });

  it("worker profile stays tiny so thousands of pods fit the client budget", () => {
    expect(resolveDbPoolOptions("worker", "main", 1)).toMatchObject({
      max: 2,
      min: 1,
      connectionTimeoutMillis: 30_000,
    });
    expect(resolveDbPoolOptions("worker", "replica", 1)).toMatchObject({
      max: 2,
      min: 0,
    });
    expect(resolveDbPoolOptions("worker", "index", 1)).toMatchObject({
      max: 2,
      min: 0,
    });
  });

  it("utility profile gives concurrent loops headroom without draining the index pool cap", () => {
    expect(resolveDbPoolOptions("utility", "main", 1)).toMatchObject({
      max: 4,
      min: 1,
    });
    expect(resolveDbPoolOptions("utility", "replica", 1)).toMatchObject({
      max: 2,
      min: 0,
    });
    expect(resolveDbPoolOptions("utility", "index", 1)).toMatchObject({
      max: 6,
      min: 0,
    });
  });

  it("never asks pg-pool to keep more connections than it may open", () => {
    for (const profile of PROFILES) {
      for (const pool of POOLS) {
        const options = resolveDbPoolOptions(profile, pool, 1);
        expect(options.min).toBeLessThanOrEqual(options.max);
        expect(options.max).toBeGreaterThan(0);
      }
    }
  });
});

describe("pickMaxLifetimeSeconds", () => {
  it("spreads lifetimes across the configured window", () => {
    expect(pickMaxLifetimeSeconds(() => 0)).toBe(MAX_LIFETIME_MIN_SECONDS);
    expect(pickMaxLifetimeSeconds(() => 0.999999)).toBe(
      MAX_LIFETIME_MIN_SECONDS + MAX_LIFETIME_SPREAD_SECONDS - 1,
    );
    expect(pickMaxLifetimeSeconds(() => 0.5)).toBe(
      MAX_LIFETIME_MIN_SECONDS + MAX_LIFETIME_SPREAD_SECONDS / 2,
    );
  });
});

/**
 * Stand-in for pg.Client that never touches the network. pg-pool drives it
 * through the same surface it uses for the real client (connect callback,
 * end, listeners, _queryable/_ending); handshakes complete only when the test
 * says so, which is what lets the tests look at the pool mid-handshake.
 */
class StubClient extends EventEmitter {
  static pending: ((err?: Error) => void)[] = [];
  static failNext = 0;
  _queryable = true;
  _ending = false;
  connection: undefined = undefined;

  connect(cb: (err?: Error) => void) {
    StubClient.pending.push(cb);
  }
  end(cb?: () => void) {
    this._ending = true;
    this.emit("end");
    cb?.();
  }
  ref() {}
  unref() {}

  /** Complete every in-flight handshake; failures are consumed first. */
  static finishAll() {
    const callbacks = StubClient.pending.splice(0);
    for (const cb of callbacks) {
      if (StubClient.failNext > 0) {
        StubClient.failNext--;
        cb(new Error("handshake failed"));
      } else {
        cb();
      }
    }
  }
}

/** Let pg-pool's nextTick-driven queue pulses and our awaits run. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => process.nextTick(resolve));
  }
}

function makePool(overrides: Partial<PoolConfig>) {
  return new Pool({
    Client: StubClient,
    connectionTimeoutMillis: 0,
    ...overrides,
  } as unknown as PoolConfig);
}

describe("keepPoolWarm (against the real pg-pool)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    StubClient.pending = [];
    StubClient.failNext = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when the profile keeps no warm connections", async () => {
    const pool = makePool({ max: 2, min: 0 });
    const stop = keepPoolWarm(pool, 0, {
      initialDelayMs: 0,
      intervalMs: 100,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.totalCount).toBe(0);
    expect(StubClient.pending).toHaveLength(0);
    stop();
  });

  it("opens one connection per tick until the pool holds `min`, then idles", async () => {
    const pool = makePool({ max: 5, min: 5 });
    const onError = vi.fn();
    const stop = keepPoolWarm(pool, 5, {
      initialDelayMs: 50,
      intervalMs: 100,
      onError,
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(pool.totalCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1); // t=50: interval armed, first tick at t=150
    expect(pool.totalCount).toBe(0);

    for (let expected = 1; expected <= 5; expected++) {
      await vi.advanceTimersByTimeAsync(100);
      // one new handshake in flight, everything opened earlier back to idle
      expect(pool.totalCount).toBe(expected);
      expect(StubClient.pending).toHaveLength(1);
      expect(pool.idleCount).toBe(expected - 1);
      StubClient.finishAll();
      await settle();
      expect(pool.idleCount).toBe(expected);
    }

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.totalCount).toBe(5);
    expect(StubClient.pending).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
    stop();
    await pool.end();
  });

  it("hands idle clients back before the new handshake completes so queries never wait behind it", async () => {
    const pool = makePool({ max: 4, min: 4 });
    // Warm three connections by hand (as traffic would).
    const clients = await Promise.all(
      [0, 1, 2].map(async () => {
        const p = pool.connect();
        StubClient.finishAll();
        return p;
      }),
    );
    for (const c of clients) c.release();
    await settle();
    expect(pool.totalCount).toBe(3);
    expect(pool.idleCount).toBe(3);

    const stop = keepPoolWarm(pool, 4, {
      initialDelayMs: 0,
      intervalMs: 100,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(100);
    // Fourth connection is mid-handshake, yet the three idle ones are already
    // available again, so a real query gets one immediately.
    expect(pool.totalCount).toBe(4);
    expect(StubClient.pending).toHaveLength(1);
    expect(pool.idleCount).toBe(3);
    const query = pool.connect();
    await settle();
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(2);
    (await query).release();

    StubClient.finishAll();
    await settle();
    expect(pool.idleCount).toBe(4);
    stop();
    await pool.end();
  });

  it("refills after pg-pool's idle eviction drains a small pool below `min`", async () => {
    // pg-pool arms the idle timer whenever a client is released while the
    // pool is above `min`, so after a two-connection burst both get evicted.
    const pool = makePool({ max: 2, min: 1, idleTimeoutMillis: 50 });
    const stop = keepPoolWarm(pool, 1, {
      initialDelayMs: 0,
      intervalMs: 100,
      onError: () => {},
    });
    const burst = [pool.connect(), pool.connect()];
    StubClient.finishAll();
    const clients = await Promise.all(burst);
    for (const c of clients) c.release();
    await settle();
    expect(pool.totalCount).toBe(2);

    await vi.advanceTimersByTimeAsync(60);
    expect(pool.totalCount).toBe(0);

    await vi.advanceTimersByTimeAsync(50); // warm-up tick at t=100
    expect(pool.totalCount).toBe(1);
    StubClient.finishAll();
    await settle();
    expect(pool.idleCount).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(pool.totalCount).toBe(1); // held at min: no idle timer at/below min
    stop();
    await pool.end();
  });

  it("reports handshake failures and keeps trying", async () => {
    const pool = makePool({ max: 2, min: 1 });
    const onError = vi.fn();
    const stop = keepPoolWarm(pool, 1, {
      initialDelayMs: 0,
      intervalMs: 100,
      onError,
    });
    StubClient.failNext = 2;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(100);
      StubClient.finishAll();
      await settle();
    }
    expect(onError).toHaveBeenCalledTimes(2);
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    stop();
    await pool.end();
  });

  it("stops when cancelled or when the pool is ending", async () => {
    const pool = makePool({ max: 3, min: 3 });
    const stop = keepPoolWarm(pool, 3, {
      initialDelayMs: 0,
      intervalMs: 100,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(100);
    StubClient.finishAll();
    await settle();
    expect(pool.totalCount).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(pool.totalCount).toBe(1);

    const again = keepPoolWarm(pool, 3, {
      initialDelayMs: 0,
      intervalMs: 100,
      onError: () => {},
    });
    await pool.end();
    await vi.advanceTimersByTimeAsync(300);
    expect(StubClient.pending).toHaveLength(0);
    again();
  });
});
