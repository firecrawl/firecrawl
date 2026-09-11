const MAX_ACTIVE_SITEMAPS = 3;
let active = 0;
const waiting = new Set<() => void>();

async function acquire(abort?: AbortSignal): Promise<() => void> {
  abort?.throwIfAborted();
  if (active >= MAX_ACTIVE_SITEMAPS) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        abort?.removeEventListener("abort", cancelled);
        resolve();
      };
      const cancelled = () => {
        waiting.delete(ready);
        reject(abort?.reason);
      };
      waiting.add(ready);
      abort?.addEventListener("abort", cancelled, { once: true });
    });
  } else {
    active++;
  }

  return () => {
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next();
    } else {
      active--;
    }
  };
}

// Hold capacity through parsing, releasing it before following child sitemaps.
export async function withSitemapPermit<T>(
  fn: () => Promise<T>,
  abort?: AbortSignal,
): Promise<T> {
  const release = await acquire(abort);
  try {
    abort?.throwIfAborted();
    return await fn();
  } finally {
    release();
  }
}
