const HEALTH_CHECK_TIMEOUT_MS = 1000;

type RedisLike = {
  status: string;
  ping: () => Promise<unknown>;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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
        await withTimeout(Promise.resolve(fn()), HEALTH_CHECK_TIMEOUT_MS, name);
        return null;
      } catch {
        return name;
      }
    }),
  );
  return results.filter((name): name is string => name !== null);
}
