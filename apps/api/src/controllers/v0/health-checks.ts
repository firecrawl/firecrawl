import { logger } from "../../lib/logger";

const HEALTH_CHECK_TIMEOUT_MS = 4000;

type RedisLike = {
  status: string;
  ping: () => Promise<unknown>;
};

export function redisEnded(client: RedisLike | null | undefined): boolean {
  return client?.status === "end";
}

export function pingIfReady(client: RedisLike): () => Promise<unknown> {
  return async () => {
    if (client.status !== "ready") {
      throw new Error(`not ready (${client.status})`);
    }
    return client.ping();
  };
}

export async function collectUnhealthy(
  checks: Array<[string, (() => Promise<unknown>) | null | undefined]>,
): Promise<string[]> {
  const active = checks.filter(
    (c): c is [string, () => Promise<unknown>] => typeof c[1] === "function",
  );
  const results = await Promise.all(
    active.map(async ([name, fn]) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error(`${name} timed out`)),
            HEALTH_CHECK_TIMEOUT_MS,
          );
          Promise.resolve(fn()).then(
            () => {
              clearTimeout(t);
              resolve();
            },
            e => {
              clearTimeout(t);
              reject(e);
            },
          );
        });
        return null;
      } catch (error) {
        logger.warn("Readiness check failed", {
          module: "health",
          check: name,
          error,
        });
        return name;
      }
    }),
  );
  return results.filter((name): name is string => name !== null);
}
