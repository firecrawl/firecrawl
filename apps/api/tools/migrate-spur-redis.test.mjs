// Requires two EMPTY, disposable local Dragonfly/Redis instances on 16389/16390.
// SPUR_MIGRATION_TEST=1 node --test tools/migrate-spur-redis.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { migrate } from "./migrate-spur-redis.mjs";
test(
  "SCAN copy preserves data and TTLs, is repeatable, and detects mismatches",
  { skip: process.env.SPUR_MIGRATION_TEST !== "1" },
  async () => {
    const source = new Redis("redis://127.0.0.1:16389");
    const target = new Redis("redis://127.0.0.1:16390");
    const opts = { pauseMs: 0, report: () => {} };
    try {
      assert.equal(await source.dbsize(), 0, "Use an empty disposable source");
      assert.equal(await target.dbsize(), 0, "Use an empty disposable target");
      await assert.rejects(migrate(source, source, opts), /distinct/);
      const count = Number(process.env.SPUR_MIGRATION_TEST_KEYS || 2000);
      for (let i = 0; i < count; i += 500) {
        const p = source.pipeline();
        for (let j = i; j < Math.min(i + 500, count); j++)
          p.set(
            `spur_context:test-${j}`,
            Buffer.from([0, 255, j % 256]),
            "EX",
            3600,
          );
        await p.exec();
      }
      await source.set("spur_context_failed:test", "1", "EX", 600);
      await source.set("spur_lock:test", "token", "EX", 600);
      await source.set("spur_context:persistent", "persistent");
      await source.set("unrelated:test", "untouched");
      await source.set("spur_unknown:test", "untouched");
      assert.ok((await migrate(source, target, opts)).matched >= count + 3);
      assert.equal(await target.dbsize(), 0);
      await migrate(source, target, { ...opts, mode: "execute" });
      assert.equal(await target.dbsize(), count + 3);
      assert.equal(await source.dbsize(), count + 5);
      assert.equal(await target.pttl("spur_context:persistent"), -1);
      assert.equal(await target.get("unrelated:test"), null);
      assert.equal(await target.get("spur_unknown:test"), null);
      const verified = await migrate(source, target, {
        ...opts,
        mode: "verify",
      });
      assert.equal(
        verified.missing + verified.different + verified.ttlDifferent,
        0,
      );
      assert.equal(
        (await migrate(source, target, { ...opts, mode: "execute" })).copied,
        0,
      );
      await target.set("spur_context:test-0", "newer");
      await target.del("spur_context:test-1");
      const mismatch = await migrate(source, target, {
        ...opts,
        mode: "verify",
      });
      assert.ok(
        mismatch.missing > 0 &&
          mismatch.different > 0 &&
          mismatch.ttlDifferent > 0,
      );
      await migrate(source, target, { ...opts, mode: "execute" });
      assert.equal(await target.get("spur_context:test-0"), "newer");
      assert.notEqual(await target.get("spur_context:test-1"), null);
      await source.lpush("spur_context:wrongtype", "wrongtype");
      await assert.rejects(
        migrate(source, target, { ...opts, mode: "execute" }),
        /WRONGTYPE/,
      );
    } finally {
      source.disconnect();
      target.disconnect();
    }
  },
);
