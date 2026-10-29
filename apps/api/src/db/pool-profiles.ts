/**
 * Postgres pool sizing presets, selected per deployment with `DB_POOL_PROFILE`.
 *
 * Every process opens its own node-pg pools against the transaction pooler.
 * With `min: 0` and pg-pool's default 10 s idle timeout, a pool drains to
 * nothing whenever traffic dips and re-opens all of its connections at once
 * when traffic jumps. Hundreds of pods doing that in the same second is a
 * login storm (a TLS handshake and an auth query per connection) that stalls
 * the pooler for every query behind it while Postgres itself sits idle; with
 * top-of-the-hour cron traffic it turns into a rhythmic latency spike.
 *
 * A profile balances the two things the pooler cares about:
 *   - warm connections per pod (`min`, kept topped up by `keepPoolWarm`),
 *     which remove the synchronized reconnects, against
 *   - the fleet-wide client budget (`pods × max` per pool has to stay under
 *     the pooler's max_client_conn), which is why horizontally scaled workers
 *     get tiny pools and only the API tier keeps large warm ones.
 *
 * Unset keeps the historical settings so deploying the code alone changes
 * nothing; the profile is switched on per deployment.
 */

type DbPoolProfile = "api" | "worker" | "utility";
export type DbPoolName = "main" | "replica" | "index";

interface DbPoolOptions {
  max: number;
  /**
   * Warm floor. pg-pool only skips the idle timer for a client released while
   * the pool is at or below `min`; it neither pre-opens connections nor refills
   * after evictions, so the floor is actually held by `keepPoolWarm`.
   */
  min: number;
  /** 0 disables idle eviction. */
  idleTimeoutMillis: number;
  /** Bounds both the connect handshake and the wait for a free slot; 0 waits forever. */
  connectionTimeoutMillis: number;
  /** 0 disables lifetime-based recycling. */
  maxLifetimeSeconds: number;
  /** undefined leaves TCP keepalive probing at the OS default (hours on Linux). */
  keepAliveInitialDelayMillis: number | undefined;
}

type PoolSize = { max: number; min: number };

/** Historical sizes, used when no profile is set. */
const DEFAULT_MAX: Record<DbPoolName, number> = {
  main: 20,
  replica: 20,
  index: 6,
};

const PROFILE_SIZES: Record<DbPoolProfile, Record<DbPoolName, PoolSize>> = {
  // API tier: a few hundred pods that see the traffic bursts first. Fully warm
  // pools so a burst never opens a connection; the budget is pods × 20.
  api: {
    main: { max: 20, min: 20 },
    replica: { max: 20, min: 20 },
    index: { max: 6, min: 6 },
  },
  // Horizontally scaled job workers (potentially thousands of pods). Each pod
  // does a handful of short writes per minute, so one warm connection covers
  // it; the replica and index pools are only touched at boot or on cache
  // misses and may drain.
  worker: {
    main: { max: 2, min: 1 },
    replica: { max: 2, min: 0 },
    index: { max: 2, min: 0 },
  },
  // Small fixed-size or moderately scaled deployments (schedulers, indexers,
  // janitors) that run several DB-bound loops concurrently.
  utility: {
    main: { max: 4, min: 1 },
    replica: { max: 2, min: 0 },
    index: { max: 6, min: 0 },
  },
};

const CONNECT_TIMEOUT_MS: Record<DbPoolProfile, number> = {
  api: 15_000,
  worker: 30_000,
  utility: 30_000,
};

/** Connections above `min` linger long enough to outlast a burst and its aftershocks. */
const WARM_IDLE_TIMEOUT_MS = 10 * 60_000;
const KEEPALIVE_DELAY_MS = 30_000;

/**
 * Lifetime recycling is randomized per process between 4 h and 8 h. A short or
 * fixed lifetime would expire every connection a burst opened at the same
 * moment, fleet-wide, just before the next burst — re-creating the cold-pool
 * problem on a schedule.
 */
const MAX_LIFETIME_MIN_SECONDS = 4 * 3600;
const MAX_LIFETIME_SPREAD_SECONDS = 4 * 3600;

export function pickMaxLifetimeSeconds(): number {
  return (
    MAX_LIFETIME_MIN_SECONDS +
    Math.floor(Math.random() * MAX_LIFETIME_SPREAD_SECONDS)
  );
}

export function resolveDbPoolOptions(
  profile: DbPoolProfile | undefined,
  pool: DbPoolName,
  maxLifetimeSeconds: number,
): DbPoolOptions {
  if (profile === undefined) {
    return {
      max: DEFAULT_MAX[pool],
      min: 0,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 0,
      maxLifetimeSeconds: 0,
      keepAliveInitialDelayMillis: undefined,
    };
  }
  const size = PROFILE_SIZES[profile][pool];
  return {
    max: size.max,
    min: size.min,
    idleTimeoutMillis: WARM_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS[profile],
    maxLifetimeSeconds,
    keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
  };
}

/** The slice of pg.Pool the warm-up loop needs. */
interface WarmablePool {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly ending: boolean;
  connect(): Promise<{ release(): void }>;
}

interface KeepWarmOptions {
  /** Delay before the first attempt, so pods started together don't log in together. */
  initialDelayMs: number;
  intervalMs: number;
  onError: (error: unknown) => void;
}

/**
 * Tops a pool up to `min` open connections, one per tick.
 *
 * pg-pool never opens connections ahead of demand, and `min` only suppresses
 * the idle timer for clients released while the pool is at or below it (a
 * client released above `min` is evicted later even if the pool has shrunk
 * since), so a fresh pod, a recycled connection or a drained worker pool would
 * otherwise do its logins in the first burst it serves. This loop pays that
 * cost gradually instead. `connect()` hands out idle clients before opening
 * new ones, so a tick briefly checks the idle ones out to force exactly one
 * new connection and hands them back as soon as it is registered. Returns a
 * function that stops the loop.
 */
export function keepPoolWarm(
  pool: WarmablePool,
  min: number,
  options: KeepWarmOptions,
): () => void {
  if (min <= 0) return () => {};

  let inFlight = false;
  const tick = async () => {
    if (inFlight || pool.ending || pool.totalCount >= min) return;
    inFlight = true;
    const held: { release(): void }[] = [];
    try {
      while (pool.idleCount > 0 && pool.totalCount < min) {
        held.push(await pool.connect());
      }
      if (pool.totalCount < min) {
        // pg-pool registers the new client synchronously inside connect(), so
        // the idle ones can go straight back: real queries never wait behind
        // this handshake, and the pool cannot refill past `min`.
        const opening = pool.connect();
        for (const client of held.splice(0)) client.release();
        held.push(await opening);
      }
    } catch (error) {
      options.onError(error);
    } finally {
      for (const client of held) client.release();
      inFlight = false;
    }
  };

  let interval: NodeJS.Timeout | undefined;
  const start = setTimeout(() => {
    interval = setInterval(() => void tick(), options.intervalMs);
    interval.unref();
  }, options.initialDelayMs);
  start.unref();

  return () => {
    clearTimeout(start);
    if (interval) clearInterval(interval);
  };
}
