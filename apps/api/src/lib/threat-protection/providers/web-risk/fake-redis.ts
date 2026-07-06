import type { WebRiskRedis } from "./store";

// In-memory stand-in for the durable Redis connection used by the threat-list
// store and sync lock (supports EX/NX set semantics and the buffer read
// variants the store uses). Test helper only.
//
// Lives in its own module with a type-only import so that vi.mock factories
// for services/queue-service can import it without re-entering the module
// being mocked (testing.ts → store.ts → queue-service would deadlock).

export function createFakeWebRiskRedis(): WebRiskRedis & {
  dump(): Map<string, Buffer>;
} {
  const store = new Map<string, { value: Buffer; expiresAt: number | null }>();

  const live = (key: string): Buffer | null => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  };

  return {
    async get(key) {
      const value = live(key);
      return value === null ? null : value.toString("utf8");
    },
    async mget(...keys) {
      return keys.map(key => {
        const value = live(key);
        return value === null ? null : value.toString("utf8");
      });
    },
    async mgetBuffer(...keys) {
      return keys.map(key => live(key));
    },
    async set(key, value, ...args) {
      const upper = args.map(a => String(a).toUpperCase());
      if (upper.includes("NX") && live(key) !== null) return null;
      const exIndex = upper.indexOf("EX");
      const expiresAt =
        exIndex !== -1 ? Date.now() + Number(args[exIndex + 1]) * 1000 : null;
      store.set(key, {
        value: Buffer.isBuffer(value) ? value : Buffer.from(String(value)),
        expiresAt,
      });
      return "OK";
    },
    async del(...keys) {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted++;
      }
      return deleted;
    },
    async expire(key, seconds) {
      const entry = store.get(key);
      if (!entry || live(key) === null) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    dump() {
      return new Map(
        [...store.entries()]
          .filter(([key]) => live(key) !== null)
          .map(([key, entry]) => [key, entry.value]),
      );
    },
  };
}
