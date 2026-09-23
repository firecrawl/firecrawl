import { v7 as uuidv7 } from "uuid";
import { logger as rootLogger } from "../../lib/logger";
import { redisEvictConnection } from "../redis";

const logger = rootLogger.child({ module: "monitoring-finalize-lease" });
const LEASE_TTL_SECONDS = 60;
const LEASE_RENEW_INTERVAL_MS = 20_000;

type MonitorCheckFinalizeLease = {
  signal: AbortSignal;
  release(): Promise<void>;
};

export async function acquireMonitorCheckFinalizeLease(
  checkId: string,
): Promise<MonitorCheckFinalizeLease | null> {
  const key = `monitor-check-finalize:${checkId}`;
  const token = uuidv7();
  const acquired =
    (await redisEvictConnection.set(
      key,
      token,
      "EX",
      LEASE_TTL_SECONDS,
      "NX",
    )) === "OK";
  if (!acquired) return null;

  const ownership = new AbortController();
  let renewing = false;
  const renew = setInterval(() => {
    if (renewing || ownership.signal.aborted) return;
    renewing = true;
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
      .then(result => {
        if (result !== 1) ownership.abort();
      })
      .catch(error => {
        ownership.abort();
        logger.warn("Failed to renew monitor finalize lease", {
          error,
          checkId,
        });
      })
      .finally(() => {
        renewing = false;
      });
  }, LEASE_RENEW_INTERVAL_MS);
  renew.unref();

  return {
    signal: ownership.signal,
    async release() {
      clearInterval(renew);
      ownership.abort();
      try {
        await redisEvictConnection.eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          end
          return 0`,
          1,
          key,
          token,
        );
      } catch (error) {
        logger.warn("Failed to release monitor finalize lease", {
          error,
          checkId,
        });
      }
    },
  };
}
