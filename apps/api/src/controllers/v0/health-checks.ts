import { logger } from "../../lib/logger";

const HEALTH_CHECK_TIMEOUT_MS = 4000;

type RedisLike = {
  status: string;
  ping: () => Promise<unknown>;
};

export function redisEnded(
  client: { status: string } | null | undefined,
): boolean {
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
      let t: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => fn()),
          new Promise<never>((_, reject) => {
            t = setTimeout(
              () => reject(new Error(`${name} timed out`)),
              HEALTH_CHECK_TIMEOUT_MS,
            );
          }),
        ]);
        return null;
      } catch (error) {
        logger.warn("Readiness check failed", {
          module: "health",
          check: name,
          error,
        });
        return name;
      } finally {
        if (t !== undefined) clearTimeout(t);
      }
    }),
  );
  return results.filter((name): name is string => name !== null);
}
