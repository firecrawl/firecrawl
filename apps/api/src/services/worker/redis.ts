import IORedis, { Redis } from "ioredis";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";

const logger = _logger.child({ module: "nuq/redis" });

const luaScripts = {
  semaphore: {
    acquire: `
-- KEYS[1]=leases_zset ; ARGV[1]=holder_id, ARGV[2]=limit, ARGV[3]=lease_ttl_ms
local t = redis.call('TIME')
local now_ms = t[1]*1000 + math.floor(t[2]/1000)

local exp = redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)

if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return {1, exp, 0}
end

local in_use = tonumber(redis.call('ZCARD', KEYS[1]))

if in_use < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], 'NX', now_ms + tonumber(ARGV[3]), ARGV[1])
  return {1, exp, in_use}
else
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, exp, in_use}
end`,

    release: `
-- KEYS[1]=leases_zset ; ARGV[1]=holder_id
return redis.call('ZREM', KEYS[1], ARGV[1])`,

    heartbeat: `
-- KEYS[1]=leases_zset ; ARGV[1]=holder_id, ARGV[2]=lease_ttl_ms
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)

local curr = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not curr then
  return 0
end

local new_expiry = now_ms + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], 'XX', new_expiry, ARGV[1])

return 1`,
  },
} as const;

type ScriptHashes = {
  [K in keyof typeof luaScripts]: {
    [K2 in keyof (typeof luaScripts)[K]]: string;
  };
};

const scripts: ScriptHashes = {} as ScriptHashes;

const redis = new IORedis(config.REDIS_URL!, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableAutoPipelining: true,
});

let initPromise: Promise<void> | null = null;

export const ensureRedis = async () => {
  if (initPromise) return initPromise;

  // If Redis is already connected/ready, just load scripts if needed
  if (redis.status === "ready") {
    initPromise = (async () => {
      for (const [k, v] of Object.entries(luaScripts)) {
        if (!scripts[k]) scripts[k] = {};
        for (const [k2, v2] of Object.entries(v)) {
          if (!scripts[k][k2]) {
            const h = await redis.script("LOAD", v2);
            scripts[k][k2] = h as string;
          }
        }
      }
    })();
    return initPromise;
  }

  initPromise = (async () => {
    // Only call connect if in 'wait' state (not yet connected)
    if (redis.status === "wait") {
      await redis.connect();
    } else if (redis.status === "connecting") {
      // Already connecting, wait for it to complete
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          redis.off("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          redis.off("ready", onReady);
          reject(err);
        };
        redis.once("ready", onReady);
        redis.once("error", onError);
      });
    } else if (redis.status !== "ready") {
      throw new Error(`Redis in unexpected state: ${redis.status}`);
    }

    for (const [k, v] of Object.entries(luaScripts)) {
      scripts[k] = {};
      for (const [k2, v2] of Object.entries(v)) {
        const h = await redis.script("LOAD", v2);
        scripts[k][k2] = h as string;
      }
    }
    logger.info("Redis connected and scripts loaded");
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
};

export const semaphoreKeys = (teamId: string) => {
  return {
    leases: `nuq:sema:{${teamId}}:leases`,
  };
};

async function runScript<T>(
  hash: string,
  keys: string[],
  args?: (string | number)[],
): Promise<T> {
  await ensureRedis();
  return (await redis.evalsha(
    hash,
    keys.length,
    ...keys,
    ...(args || []),
  )) as T;
}

type NuQRedis = Redis & {
  scripts: typeof scripts;
  runScript: typeof runScript;
  ensure: typeof ensureRedis;
};

export const nuqRedis: NuQRedis = Object.assign(redis, {
  scripts,
  runScript,
  ensure: ensureRedis,
});
