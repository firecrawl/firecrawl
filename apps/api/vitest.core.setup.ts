import type { Redis, RedisOptions } from "ioredis";
import { vi } from "vitest";

interface IORedisModule {
  default: typeof Redis;
  Redis: typeof Redis;
}

// The core suite runs without Redis, but many modules create a Redis client
// when they are imported. Make every client connect on first use, so importing
// a module opens no connection.
vi.mock("ioredis", async importOriginal => {
  const ioredis = await importOriginal<IORedisModule>();

  class LazyRedis extends ioredis.Redis {
    constructor(port: number, host: string, options: RedisOptions);
    constructor(path: string, options: RedisOptions);
    constructor(port: number, options: RedisOptions);
    constructor(port: number, host: string);
    constructor(options: RedisOptions);
    constructor(port: number);
    constructor(path: string);
    constructor();
    constructor(
      arg1?: number | string | RedisOptions,
      arg2?: string | RedisOptions,
      arg3?: RedisOptions,
    ) {
      if (typeof arg1 === "number" && typeof arg2 === "string") {
        super(arg1, arg2, {
          ...arg3,
          lazyConnect: arg3?.lazyConnect ?? true,
        });
      } else if (typeof arg1 === "string") {
        const opts = typeof arg2 === "object" && arg2 !== null ? arg2 : {};
        super(arg1, { ...opts, lazyConnect: opts.lazyConnect ?? true });
      } else if (typeof arg1 === "number") {
        const opts = typeof arg2 === "object" && arg2 !== null ? arg2 : {};
        super(arg1, { ...opts, lazyConnect: opts.lazyConnect ?? true });
      } else if (typeof arg1 === "object" && arg1 !== null) {
        super({ ...arg1, lazyConnect: arg1.lazyConnect ?? true });
      } else {
        super({ lazyConnect: true });
      }
    }
  }

  return { ...ioredis, default: LazyRedis, Redis: LazyRedis };
});
