import { v7 as uuidv7 } from "uuid";
import { logger as rootLogger } from "../../lib/logger";
import { redisEvictConnection } from "../redis";

const logger = rootLogger.child({ module: "monitoring-finalize-lease" });
const LEASE_TTL_SECONDS = 60;
const LEASE_RENEW_INTERVAL_MS = 20_000;

type MonitorCheckFinalizeLease = {
  release(): Promise<void>;
};

export async function acquireMonitorCheckFinalizeLease(
  checkId: string,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<MonitorCheckFinalizeLease | null> {
  const key = `monitor-check-finalize:${checkId}`;
  const token = uuidv7();
  const attempts = options.attempts ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 100;

  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    acquired =
      (await redisEvictConnection.set(
        key,
        token,
        "EX",
        LEASE_TTL_SECONDS,
        "NX",
      )) === "OK";
    if (acquired) break;
    if (attempt + 1 < attempts) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  if (!acquired) return null;

  const renew = setInterval(() => {
    redisEvictConnection
      .eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        end
        return 0`,
        1,
        key,
        token,
        LEASE_TTL_SECONDS,
      )
      .catch(error =>
        logger.warn("Failed to renew monitor finalize lease", {
          error,
          checkId,
        }),
      );
  }, LEASE_RENEW_INTERVAL_MS);
  renew.unref();

  return {
    async release() {
      clearInterval(renew);
      await redisEvictConnection.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        end
        return 0`,
        1,
        key,
        token,
      );
    },
  };
}
