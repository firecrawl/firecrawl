vi.mock("../config", () => ({ config: { INDEX_CACHE_REDIS_URL: undefined } }));
import { getCachedMaxAge } from "./index-cache";
it.each([
  "null",
  "[]",
  "1",
  "{}",
  '{"max_age":"100"}',
  '{"max_age":true}',
  '{"max_age":{}}',
  '{"max_age":1e999}',
  "bad json",
])("treats malformed max-age %s as a miss", async raw => {
  await expect(
    getCachedMaxAge(Buffer.from("domain"), undefined, {
      get: async () => raw,
    } as any),
  ).resolves.toBeNull();
});
it.each([null, 0, 100])("accepts numeric or null max-age %s", async max_age => {
  await expect(
    getCachedMaxAge(Buffer.from("domain"), undefined, {
      get: async () => JSON.stringify({ max_age }),
    } as any),
  ).resolves.toEqual({ maxAge: max_age });
});
it("preserves Redis read failures", async () => {
  const original = new Error("Redis read failed");
  await expect(
    getCachedMaxAge(Buffer.from("domain"), undefined, {
      get: async () => {
        throw original;
      },
    } as any),
  ).rejects.toBe(original);
});
