import type { Redis } from "ioredis";
import IORedis from "ioredis";
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
  -readonly [K in keyof typeof luaScripts]: {
    -readonly [K2 in keyof (typeof luaScripts)[K]]: string;
  };
};

const scripts: ScriptHashes = {
  semaphore: {
    acquire: "",
    release: "",
    heartbeat: "",
  },
};

const SEMAPHORE_SCRIPT_NAMES = ["acquire", "release", "heartbeat"] as const;

const redisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableAutoPipelining: true,
};

const redis = config.REDIS_URL
  ? new IORedis(config.REDIS_URL, redisOptions)
  : new IORedis(redisOptions);

let initPromise: Promise<void> | null = null;

async function loadScript(source: string): Promise<string> {
  const hash = await redis.script("LOAD", source);
  if (typeof hash !== "string") {
    throw new Error("Redis SCRIPT LOAD did not return a hash string");
  }
  return hash;
}

async function loadSemaphoreScripts(onlyMissing: boolean): Promise<void> {
  for (const name of SEMAPHORE_SCRIPT_NAMES) {
    if (!onlyMissing || !scripts.semaphore[name]) {
      scripts.semaphore[name] = await loadScript(luaScripts.semaphore[name]);
    }
  }
}

async function ensureConnected(): Promise<void> {
  if (redis.status === "ready") {
    return;
  }
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
  } else {
    throw new Error(`Redis in unexpected state: ${redis.status}`);
  }
}

export const ensureRedis = async () => {
  if (initPromise) {
    return initPromise;
  }

  // If Redis is already connected/ready, just load scripts if needed
  if (redis.status === "ready") {
    initPromise = loadSemaphoreScripts(true).catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  }

  initPromise = (async () => {
    await ensureConnected();
    await loadSemaphoreScripts(false);
    logger.info("Redis connected and scripts loaded");
  })().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
};

let reloadPromise: Promise<void> | null = null;

function reloadSemaphoreScripts(): Promise<void> {
  if (reloadPromise) {
    return reloadPromise;
  }
  initPromise = (async () => {
    await ensureConnected();
    await loadSemaphoreScripts(false);
  })().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  reloadPromise = initPromise.finally(() => {
    reloadPromise = null;
  });
  return reloadPromise;
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}

export const shutdownRedis = async () => {
  initPromise = null;
  reloadPromise = null;
  for (const name of SEMAPHORE_SCRIPT_NAMES) {
    scripts.semaphore[name] = "";
  }

  if (redis.status === "wait" || redis.status === "end") {
    return;
  }

  try {
    await redis.quit();
  } catch (error: unknown) {
    logger.warn("Error while closing NuQ Redis connection", { err: error });
    redis.disconnect();
  }
};

export const semaphoreKeys = (teamId: string) => {
  return {
    leases: `nuq:sema:{${teamId}}:leases`,
  };
};

async function runScript<T>(
  hash: string,
  keys: Array<string>,
  args: Array<string | number> | undefined,
  parse: (result: unknown) => T,
): Promise<T> {
  await ensureRedis();
  const scriptName = SEMAPHORE_SCRIPT_NAMES.find(
    name => scripts.semaphore[name] === hash,
  );
  const exec = (scriptHash: string) =>
    redis.evalsha(scriptHash, keys.length, ...keys, ...(args || []));
  try {
    return parse(await exec(hash));
  } catch (error: unknown) {
    if (!isNoScriptError(error)) {
      throw error;
    }
    await reloadSemaphoreScripts();
    const reloadedHash = scriptName ? scripts.semaphore[scriptName] : hash;
    return parse(await exec(reloadedHash));
  }
}

type NuQRedis = Redis & {
  scripts: typeof scripts;
  runScript: typeof runScript;
  ensure: typeof ensureRedis;
  shutdown: typeof shutdownRedis;
};

export const nuqRedis: NuQRedis = Object.assign(redis, {
  scripts,
  runScript,
  ensure: ensureRedis,
  shutdown: shutdownRedis,
});
