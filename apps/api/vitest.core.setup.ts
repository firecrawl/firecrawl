import { vi } from "vitest";

// The core suite runs without Redis, but many modules create a Redis client
// when they are imported. Make every client connect on first use, so importing
// a module opens no connection.
vi.mock("ioredis", async importOriginal => {
  const ioredis = await importOriginal<typeof import("ioredis")>();

  const LazyRedis = new Proxy(ioredis.Redis, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, [...args, { lazyConnect: true }], newTarget),
  });

  return { ...ioredis, default: LazyRedis, Redis: LazyRedis };
});
