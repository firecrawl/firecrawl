/**
 * Cache Compatibility Integration Tests
 *
 * These tests verify that the application works correctly with both Redis and Valkey
 * as cache backends. Since Valkey is a drop-in replacement for Redis, these tests
 * exercise the Redis operations used throughout the application to ensure compatibility.
 *
 * The CI/CD pipeline runs these tests against both Redis and Valkey images to
 * officially confirm support for both backends.
 *
 * NOTE: These tests only run in CI environments (where the CI env var is set).
 * To run locally, either:
 * - Set CI=true: CI=true pnpm test cache-compatibility
 * - Or ensure Redis is accessible at localhost:6379
 *
 * Feature Coverage:
 * - Job queues (BullMQ) - "BullMQ Queue Operations"
 * - Rate limiting - "Atomic Counter Operations" (INCR/EXPIRE pattern used by rate-limiter-flexible)
 * - Auth/credit caching - "Basic Operations", "Expiration", "Distributed Locking"
 * - Crawl state management - "Set Operations", "Pipeline Operations"
 * - URL de-duplication - "Set Operations" (SADD returns 0 for duplicates)
 * - Distributed locks - "Distributed Locking (Redlock)"
 * - Team concurrency semaphore - "Sorted Set Operations", "Lua Script Execution"
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "@jest/globals";

// Skip these tests when not in CI to avoid failures for new users
const runCacheTests =
  process.env.CI === "true" || process.env.RUN_CACHE_TESTS === "true";
const describeIfCI = runCacheTests ? describe : describe.skip;
import Redis from "ioredis";
import { Queue, Worker, Job } from "bullmq";
import Redlock from "redlock";
import { config } from "../../../config";

interface BackendInfo {
  serverName: string | null;
  valkeyVersion: string | null;
  redisVersion: string | null;
  isValkey: boolean;
}

/**
 * Detects whether the connected cache backend is Valkey or Redis.
 * Valkey adds `server_name:valkey` and `valkey_version:x.x.x` fields
 * to the INFO SERVER response that Redis doesn't have.
 */
async function detectBackend(redis: Redis): Promise<BackendInfo> {
  const info = await redis.info("server");

  // Parse server_name (Valkey has this, Redis doesn't)
  const serverNameMatch = info.match(/server_name:(\w+)/);
  const serverName = serverNameMatch ? serverNameMatch[1] : null;

  const valkeyVersionMatch = info.match(/valkey_version:(\S+)/);
  const valkeyVersion = valkeyVersionMatch ? valkeyVersionMatch[1] : null;

  const redisVersionMatch = info.match(/redis_version:(\S+)/);
  const redisVersion = redisVersionMatch ? redisVersionMatch[1] : null;

  return {
    serverName,
    valkeyVersion,
    redisVersion,
    isValkey: serverName === "valkey" || valkeyVersion !== null,
  };
}

const TEST_KEY_PREFIX = "test:cache-compat:";

describeIfCI("Cache Compatibility Tests (Redis/Valkey)", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(config.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    await redis.ping();

    // Log which cache we're testing against
    const backendInfo = await detectBackend(redis);
    if (backendInfo.isValkey) {
      console.log(`\n Testing against Valkey ${backendInfo.valkeyVersion}\n`);
    } else {
      console.log(`\n Testing against Redis ${backendInfo.redisVersion}\n`);
    }
  });

  afterAll(async () => {
    // Clean up all test keys
    const keys = await redis.keys(`${TEST_KEY_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();
  });

  beforeEach(async () => {
    // Clean up test keys before each test
    const keys = await redis.keys(`${TEST_KEY_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe("Basic Operations (SET, GET, DEL)", () => {
    it("should SET and GET a value correctly", async () => {
      const key = `${TEST_KEY_PREFIX}basic:setget`;
      const value = "test-value-123";

      await redis.set(key, value);
      const result = await redis.get(key);

      expect(result).toBe(value);
    });

    it("should return null for non-existent key", async () => {
      const key = `${TEST_KEY_PREFIX}basic:nonexistent`;

      const result = await redis.get(key);

      expect(result).toBeNull();
    });

    it("should DEL a key correctly", async () => {
      const key = `${TEST_KEY_PREFIX}basic:del`;
      const value = "to-be-deleted";

      await redis.set(key, value);
      const beforeDel = await redis.get(key);
      expect(beforeDel).toBe(value);

      const delResult = await redis.del(key);
      expect(delResult).toBe(1);

      const afterDel = await redis.get(key);
      expect(afterDel).toBeNull();
    });

    it("should handle JSON values correctly", async () => {
      const key = `${TEST_KEY_PREFIX}basic:json`;
      const value = { foo: "bar", count: 42, nested: { a: 1 } };

      await redis.set(key, JSON.stringify(value));
      const result = await redis.get(key);

      expect(JSON.parse(result!)).toEqual(value);
    });
  });

  describe("Expiration (EX option)", () => {
    it("should SET with EX option and retrieve before expiration", async () => {
      const key = `${TEST_KEY_PREFIX}expiry:ex`;
      const value = "expiring-value";
      const ttlSeconds = 60;

      await redis.set(key, value, "EX", ttlSeconds);
      const result = await redis.get(key);

      expect(result).toBe(value);

      // Verify TTL is set
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(ttlSeconds);
    });

    it("should EXPIRE a key correctly", async () => {
      const key = `${TEST_KEY_PREFIX}expiry:expire`;
      const value = "will-expire";

      await redis.set(key, value);
      const expireResult = await redis.expire(key, 60);

      expect(expireResult).toBe(1);

      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
    });

    it("should support EXPIRE with NX option", async () => {
      const key = `${TEST_KEY_PREFIX}expiry:nx`;
      const value = "nx-expire";

      // Set without TTL
      await redis.set(key, value);

      // EXPIRE NX should succeed (no TTL exists)
      const result1 = await redis.expire(key, 60, "NX");
      expect(result1).toBe(1);

      // EXPIRE NX should fail (TTL already exists)
      const result2 = await redis.expire(key, 120, "NX");
      expect(result2).toBe(0);
    });
  });

  describe("Conditional Operations (NX option)", () => {
    it("should SET NX succeed on new key", async () => {
      const key = `${TEST_KEY_PREFIX}nx:new`;
      const value = "first-value";

      const result = await redis.set(key, value, "NX");

      expect(result).toBe("OK");
      expect(await redis.get(key)).toBe(value);
    });

    it("should SET NX fail on existing key", async () => {
      const key = `${TEST_KEY_PREFIX}nx:existing`;
      const value1 = "first-value";
      const value2 = "second-value";

      await redis.set(key, value1);
      const result = await redis.set(key, value2, "NX");

      expect(result).toBeNull();
      expect(await redis.get(key)).toBe(value1);
    });
  });

  describe("Sorted Set Operations (used by semaphore)", () => {
    it("should ZADD members with scores", async () => {
      const key = `${TEST_KEY_PREFIX}zset:add`;

      const result = await redis.zadd(key, 100, "member1", 200, "member2");

      expect(result).toBe(2);
    });

    it("should ZSCORE retrieve correct score", async () => {
      const key = `${TEST_KEY_PREFIX}zset:score`;
      const score = 12345;

      await redis.zadd(key, score, "member1");
      const result = await redis.zscore(key, "member1");

      expect(result).toBe(score.toString());
    });

    it("should ZCARD return correct count", async () => {
      const key = `${TEST_KEY_PREFIX}zset:card`;

      await redis.zadd(key, 1, "a", 2, "b", 3, "c");
      const count = await redis.zcard(key);

      expect(count).toBe(3);
    });

    it("should ZREM remove members", async () => {
      const key = `${TEST_KEY_PREFIX}zset:rem`;

      await redis.zadd(key, 1, "a", 2, "b", 3, "c");
      const removed = await redis.zrem(key, "b");

      expect(removed).toBe(1);
      expect(await redis.zcard(key)).toBe(2);
      expect(await redis.zscore(key, "b")).toBeNull();
    });

    it("should ZRANGE return members in order", async () => {
      const key = `${TEST_KEY_PREFIX}zset:range`;

      await redis.zadd(key, 3, "c", 1, "a", 2, "b");
      const members = await redis.zrange(key, 0, -1);

      expect(members).toEqual(["a", "b", "c"]);
    });

    it("should ZRANGE with WITHSCORES return members and scores", async () => {
      const key = `${TEST_KEY_PREFIX}zset:range-scores`;

      await redis.zadd(key, 10, "first", 20, "second");
      const result = await redis.zrange(key, 0, 0, "WITHSCORES");

      expect(result).toEqual(["first", "10"]);
    });

    it("should ZREMRANGEBYSCORE remove by score range", async () => {
      const key = `${TEST_KEY_PREFIX}zset:remrange`;
      const now = Date.now();

      // Add members with timestamps as scores
      await redis.zadd(
        key,
        now - 1000,
        "expired1",
        now - 500,
        "expired2",
        now + 1000,
        "valid",
      );

      // Remove expired entries (score < now)
      const removed = await redis.zremrangebyscore(key, "-inf", now);

      expect(removed).toBe(2);
      expect(await redis.zcard(key)).toBe(1);
    });

    it("should support ZADD with NX option", async () => {
      const key = `${TEST_KEY_PREFIX}zset:addnx`;

      // First add should succeed
      await redis.zadd(key, "NX", 100, "member1");
      expect(await redis.zscore(key, "member1")).toBe("100");

      // NX should not update existing member
      await redis.zadd(key, "NX", 200, "member1");
      expect(await redis.zscore(key, "member1")).toBe("100");
    });

    it("should support ZADD with XX option", async () => {
      const key = `${TEST_KEY_PREFIX}zset:addxx`;

      // XX should not add new member
      await redis.zadd(key, "XX", 100, "member1");
      expect(await redis.zscore(key, "member1")).toBeNull();

      // Add member first
      await redis.zadd(key, 100, "member1");

      // XX should update existing member
      await redis.zadd(key, "XX", 200, "member1");
      expect(await redis.zscore(key, "member1")).toBe("200");
    });

    it("should ZCOUNT return count of members in score range", async () => {
      const key = `${TEST_KEY_PREFIX}zset:count`;
      const now = Date.now();

      // Add members with timestamps as scores
      await redis.zadd(
        key,
        now - 1000,
        "expired1",
        now + 1000,
        "active1",
        now + 2000,
        "active2",
        now + 3000,
        "active3",
      );

      // Count active members (score > now)
      const activeCount = await redis.zcount(key, now, "+inf");
      expect(activeCount).toBe(3);

      // Count expired members (score < now)
      const expiredCount = await redis.zcount(key, "-inf", now);
      expect(expiredCount).toBe(1);
    });

    it("should ZRANGEBYSCORE return members in score range", async () => {
      const key = `${TEST_KEY_PREFIX}zset:rangebyscore`;
      const now = Date.now();

      await redis.zadd(
        key,
        now - 1000,
        "expired",
        now + 1000,
        "active1",
        now + 2000,
        "active2",
      );

      // Get active members (score > now)
      const activeMembers = await redis.zrangebyscore(key, now, "+inf");
      expect(activeMembers).toEqual(["active1", "active2"]);
    });

    it("should ZRANGEBYSCORE with LIMIT option", async () => {
      const key = `${TEST_KEY_PREFIX}zset:rangebyscore-limit`;

      await redis.zadd(key, 1, "a", 2, "b", 3, "c", 4, "d", 5, "e");

      // Get first 2 members with score >= 2
      const members = await redis.zrangebyscore(key, 2, "+inf", "LIMIT", 0, 2);
      expect(members).toEqual(["b", "c"]);
    });

    it("should ZSCAN iterate through sorted set members", async () => {
      const key = `${TEST_KEY_PREFIX}zset:scan`;

      // Add many members
      for (let i = 0; i < 20; i++) {
        await redis.zadd(key, i * 100, `member${i}`);
      }

      const foundMembers: string[] = [];
      let cursor = "0";

      do {
        const [newCursor, results] = await redis.zscan(
          key,
          cursor,
          "COUNT",
          10,
        );
        cursor = newCursor;
        // format: [member, score, member, score, ...]
        for (let i = 0; i < results.length; i += 2) {
          foundMembers.push(results[i]);
        }
      } while (cursor !== "0");

      expect(foundMembers.length).toBe(20);
    });
  });

  describe("Lua Script Execution", () => {
    it("should SCRIPT LOAD and EVALSHA execute correctly", async () => {
      const script = `return redis.call('SET', KEYS[1], ARGV[1])`;
      const key = `${TEST_KEY_PREFIX}lua:basic`;
      const value = "lua-set-value";

      const sha = (await redis.script("LOAD", script)) as string;
      expect(typeof sha).toBe("string");
      expect(sha.length).toBe(40); // SHA1 hash length

      const result = await redis.evalsha(sha, 1, key, value);
      expect(result).toBe("OK");
      expect(await redis.get(key)).toBe(value);
    });

    it("should execute TIME command in Lua script", async () => {
      // This tests the TIME command used in semaphore scripts
      const script = `
        local t = redis.call('TIME')
        return t[1] * 1000 + math.floor(t[2] / 1000)
      `;

      const sha = (await redis.script("LOAD", script)) as string;
      const result = (await redis.evalsha(sha, 0)) as number;

      // Result should be close to current time in milliseconds
      const now = Date.now();
      expect(result).toBeGreaterThan(now - 5000);
      expect(result).toBeLessThan(now + 5000);
    });

    it("should execute semaphore-like acquire script", async () => {
      const key = `${TEST_KEY_PREFIX}lua:semaphore`;
      const holderId = "holder-123";
      const limit = 5;
      const leaseTtlMs = 30000;

      const acquireScript = `
        local t = redis.call('TIME')
        local now_ms = t[1]*1000 + math.floor(t[2]/1000)
        
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
        
        if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
          return {1, 0, 0}
        end
        
        local in_use = tonumber(redis.call('ZCARD', KEYS[1]))
        
        if in_use < tonumber(ARGV[2]) then
          redis.call('ZADD', KEYS[1], 'NX', now_ms + tonumber(ARGV[3]), ARGV[1])
          return {1, 0, in_use}
        else
          return {0, 0, in_use}
        end
      `;

      const sha = (await redis.script("LOAD", acquireScript)) as string;
      const result = (await redis.evalsha(
        sha,
        1,
        key,
        holderId,
        limit,
        leaseTtlMs,
      )) as number[];

      // Should acquire successfully (result[0] = 1)
      expect(result[0]).toBe(1);
    });

    it("should execute semaphore-like release script", async () => {
      const key = `${TEST_KEY_PREFIX}lua:release`;
      const holderId = "holder-456";

      // Add a lease first
      await redis.zadd(key, Date.now() + 30000, holderId);

      const releaseScript = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

      const sha = (await redis.script("LOAD", releaseScript)) as string;
      const result = await redis.evalsha(sha, 1, key, holderId);

      expect(result).toBe(1);
      expect(await redis.zscore(key, holderId)).toBeNull();
    });
  });

  describe("BullMQ Queue Operations", () => {
    const queueName = "test-cache-compat-queue"; // BullMQ doesn't allow colons in queue names
    let queue: Queue;
    let worker: Worker;

    beforeAll(() => {
      queue = new Queue(queueName, {
        connection: {
          host: new URL(config.REDIS_URL!).hostname,
          port: parseInt(new URL(config.REDIS_URL!).port || "6379"),
        },
      });
    });

    afterAll(async () => {
      if (worker) {
        await worker.close();
      }
      await queue.obliterate({ force: true });
      await queue.close();
    });

    it("should add and retrieve a job", async () => {
      const jobData = {
        url: "https://example.com",
        options: { timeout: 30000 },
      };

      const job = await queue.add("test-job", jobData);

      expect(job.id).toBeDefined();
      expect(job.data).toEqual(jobData);

      // Retrieve the job
      const retrievedJob = await queue.getJob(job.id!);
      expect(retrievedJob).toBeDefined();
      expect(retrievedJob!.data).toEqual(jobData);
    });

    it("should process a job with a worker", async () => {
      const jobData = { value: 42 };
      let processedData: any = null;

      worker = new Worker(
        queueName,
        async (job: Job) => {
          processedData = job.data;
          return { success: true };
        },
        {
          connection: {
            host: new URL(config.REDIS_URL!).hostname,
            port: parseInt(new URL(config.REDIS_URL!).port || "6379"),
          },
        },
      );

      // Declare job before the listeners so the closures never hit a TDZ.
      let job: Job | undefined;

      // Set up event listeners before adding the job to avoid a race
      // where the job completes before listeners are registered.
      const jobProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Job processing timeout")),
          5000,
        );
        worker.on("completed", completedJob => {
          if (completedJob.id === job?.id) {
            clearTimeout(timeout);
            resolve();
          }
        });
        worker.on("failed", (failedJob, err) => {
          if (failedJob?.id === job?.id) {
            clearTimeout(timeout);
            reject(err);
          }
        });
      });

      job = await queue.add("process-test", jobData);

      // Wait for job to be processed
      await jobProcessed;

      expect(processedData).toEqual(jobData);
    });
  });

  describe("Pipeline Operations", () => {
    it("should execute multiple commands in a pipeline", async () => {
      const key1 = `${TEST_KEY_PREFIX}pipeline:1`;
      const key2 = `${TEST_KEY_PREFIX}pipeline:2`;

      const results = await redis
        .pipeline()
        .set(key1, "value1")
        .set(key2, "value2")
        .get(key1)
        .get(key2)
        .exec();

      expect(results).toHaveLength(4);
      expect(results![0]).toEqual([null, "OK"]);
      expect(results![1]).toEqual([null, "OK"]);
      expect(results![2]).toEqual([null, "value1"]);
      expect(results![3]).toEqual([null, "value2"]);
    });
  });

  describe("Atomic Counter Operations (INCR/DECR) - used by billing", () => {
    it("should INCR a non-existent key starting from 0", async () => {
      const key = `${TEST_KEY_PREFIX}counter:new`;

      const result = await redis.incr(key);

      expect(result).toBe(1);
    });

    it("should INCR an existing key", async () => {
      const key = `${TEST_KEY_PREFIX}counter:existing`;
      await redis.set(key, "10");

      const result = await redis.incr(key);

      expect(result).toBe(11);
    });

    it("should INCRBY increment by specific amount", async () => {
      const key = `${TEST_KEY_PREFIX}counter:incrby`;
      await redis.set(key, "5");

      const result = await redis.incrby(key, 10);

      expect(result).toBe(15);
    });

    it("should DECR a key", async () => {
      const key = `${TEST_KEY_PREFIX}counter:decr`;
      await redis.set(key, "10");

      const result = await redis.decr(key);

      expect(result).toBe(9);
    });

    it("should DECRBY decrement by specific amount", async () => {
      const key = `${TEST_KEY_PREFIX}counter:decrby`;
      await redis.set(key, "20");

      const result = await redis.decrby(key, 7);

      expect(result).toBe(13);
    });

    it("should handle INCR with EXPIRE for rate limiting pattern", async () => {
      const key = `${TEST_KEY_PREFIX}counter:rate-limit`;

      const count = await redis.incr(key);
      await redis.expire(key, 60);

      expect(count).toBe(1);

      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      // Subsequent increments should work
      const count2 = await redis.incr(key);
      expect(count2).toBe(2);
    });
  });

  describe("Set Operations (SADD/SMEMBERS/SREM) - used by crawl tracking", () => {
    it("should SADD single member to set", async () => {
      const key = `${TEST_KEY_PREFIX}set:single`;

      const result = await redis.sadd(key, "member1");

      expect(result).toBe(1);
    });

    it("should SADD multiple members to set", async () => {
      const key = `${TEST_KEY_PREFIX}set:multiple`;

      const result = await redis.sadd(key, "member1", "member2", "member3");

      expect(result).toBe(3);
    });

    it("should SADD return 0 for duplicate members", async () => {
      const key = `${TEST_KEY_PREFIX}set:duplicate`;

      await redis.sadd(key, "member1");
      const result = await redis.sadd(key, "member1");

      expect(result).toBe(0);
    });

    it("should SMEMBERS return all set members", async () => {
      const key = `${TEST_KEY_PREFIX}set:members`;
      await redis.sadd(key, "a", "b", "c");

      const members = await redis.smembers(key);

      expect(members.sort()).toEqual(["a", "b", "c"]);
    });

    it("should SMEMBERS return empty array for non-existent set", async () => {
      const key = `${TEST_KEY_PREFIX}set:nonexistent`;

      const members = await redis.smembers(key);

      expect(members).toEqual([]);
    });

    it("should SREM remove single member from set", async () => {
      const key = `${TEST_KEY_PREFIX}set:rem-single`;
      await redis.sadd(key, "a", "b", "c");

      const result = await redis.srem(key, "b");

      expect(result).toBe(1);
      const members = await redis.smembers(key);
      expect(members.sort()).toEqual(["a", "c"]);
    });

    it("should SREM remove multiple members from set", async () => {
      const key = `${TEST_KEY_PREFIX}set:rem-multiple`;
      await redis.sadd(key, "a", "b", "c", "d");

      const result = await redis.srem(key, "b", "d");

      expect(result).toBe(2);
      const members = await redis.smembers(key);
      expect(members.sort()).toEqual(["a", "c"]);
    });

    it("should SREM return 0 for non-existent member", async () => {
      const key = `${TEST_KEY_PREFIX}set:rem-nonexistent`;
      await redis.sadd(key, "a", "b");

      const result = await redis.srem(key, "z");

      expect(result).toBe(0);
    });

    it("should SCARD return set cardinality", async () => {
      const key = `${TEST_KEY_PREFIX}set:card`;
      await redis.sadd(key, "a", "b", "c");

      const count = await redis.scard(key);

      expect(count).toBe(3);
    });

    it("should SISMEMBER check membership correctly", async () => {
      const key = `${TEST_KEY_PREFIX}set:ismember`;
      await redis.sadd(key, "member1", "member2");

      const isMember = await redis.sismember(key, "member1");
      const isNotMember = await redis.sismember(key, "nonexistent");

      expect(isMember).toBe(1);
      expect(isNotMember).toBe(0);
    });

    it("should handle crawl job tracking pattern", async () => {
      const crawlId = "test-crawl-123";
      const jobsKey = `${TEST_KEY_PREFIX}crawl:${crawlId}:jobs`;
      const visitedKey = `${TEST_KEY_PREFIX}crawl:${crawlId}:visited`;

      await redis.sadd(jobsKey, "job1", "job2", "job3");

      // Mark URLs as visited
      await redis.sadd(
        visitedKey,
        "https://example.com/page1",
        "https://example.com/page2",
      );

      // Verify
      const jobs = await redis.smembers(jobsKey);
      expect(jobs.length).toBe(3);

      const visited = await redis.smembers(visitedKey);
      expect(visited.length).toBe(2);

      await redis.srem(jobsKey, "job1");
      const remainingJobs = await redis.smembers(jobsKey);
      expect(remainingJobs.length).toBe(2);
    });

    it("should SPOP remove and return random member", async () => {
      const key = `${TEST_KEY_PREFIX}set:spop`;
      await redis.sadd(key, "a", "b", "c", "d", "e");

      const popped = await redis.spop(key);

      expect(popped).toBeDefined();
      expect(["a", "b", "c", "d", "e"]).toContain(popped);
      expect(await redis.scard(key)).toBe(4);
    });

    it("should SPOP remove multiple random members", async () => {
      const key = `${TEST_KEY_PREFIX}set:spop-multi`;
      await redis.sadd(key, "a", "b", "c", "d", "e");

      const popped = await redis.spop(key, 3);

      expect(popped).toHaveLength(3);
      expect(await redis.scard(key)).toBe(2);
    });

    it("should SRANDMEMBER return random member without removing", async () => {
      const key = `${TEST_KEY_PREFIX}set:srandmember`;
      await redis.sadd(key, "team1", "team2", "team3");

      const member = await redis.srandmember(key);

      expect(member).toBeDefined();
      expect(["team1", "team2", "team3"]).toContain(member);
      // Member should still be in set
      expect(await redis.scard(key)).toBe(3);
    });

    it("should SRANDMEMBER return multiple random members", async () => {
      const key = `${TEST_KEY_PREFIX}set:srandmember-multi`;
      await redis.sadd(key, "a", "b", "c", "d", "e");

      const members = await redis.srandmember(key, 3);

      expect(members).toHaveLength(3);
      // All members should still be in set
      expect(await redis.scard(key)).toBe(5);
    });
  });

  describe("List Operations (RPUSH/LPOP/RPOP/LLEN) - used by batch billing", () => {
    it("should RPUSH add elements to the right of list", async () => {
      const key = `${TEST_KEY_PREFIX}list:rpush`;

      const result = await redis.rpush(key, "a", "b", "c");

      expect(result).toBe(3);
    });

    it("should LPOP remove and return element from left", async () => {
      const key = `${TEST_KEY_PREFIX}list:lpop`;
      await redis.rpush(key, "first", "second", "third");

      const result = await redis.lpop(key);

      expect(result).toBe("first");
      expect(await redis.llen(key)).toBe(2);
    });

    it("should RPOP remove and return element from right", async () => {
      const key = `${TEST_KEY_PREFIX}list:rpop`;
      await redis.rpush(key, "first", "second", "third");

      const result = await redis.rpop(key);

      expect(result).toBe("third");
      expect(await redis.llen(key)).toBe(2);
    });

    it("should LPOP return null for empty list", async () => {
      const key = `${TEST_KEY_PREFIX}list:lpop-empty`;

      const result = await redis.lpop(key);

      expect(result).toBeNull();
    });

    it("should LLEN return list length", async () => {
      const key = `${TEST_KEY_PREFIX}list:llen`;
      await redis.rpush(key, "a", "b", "c", "d");

      const length = await redis.llen(key);

      expect(length).toBe(4);
    });

    it("should LLEN return 0 for non-existent list", async () => {
      const key = `${TEST_KEY_PREFIX}list:llen-empty`;

      const length = await redis.llen(key);

      expect(length).toBe(0);
    });

    it("should handle batch billing queue pattern", async () => {
      const queueKey = `${TEST_KEY_PREFIX}billing:batch`;

      // Add operations to queue
      const op1 = JSON.stringify({ type: "credit", amount: 100 });
      const op2 = JSON.stringify({ type: "debit", amount: 50 });
      await redis.rpush(queueKey, op1, op2);

      const queueLength = await redis.llen(queueKey);
      expect(queueLength).toBe(2);

      const processed = await redis.lpop(queueKey);
      expect(JSON.parse(processed!)).toEqual({ type: "credit", amount: 100 });

      expect(await redis.llen(queueKey)).toBe(1);
    });
  });

  describe("SCAN Operations - used by admin metrics", () => {
    it("should SCAN iterate through keys", async () => {
      // Create test keys
      for (let i = 0; i < 10; i++) {
        await redis.set(`${TEST_KEY_PREFIX}scan:key${i}`, `value${i}`);
      }

      const foundKeys: string[] = [];
      let cursor = "0";

      do {
        const [newCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${TEST_KEY_PREFIX}scan:*`,
          "COUNT",
          100,
        );
        cursor = newCursor;
        foundKeys.push(...keys);
      } while (cursor !== "0");

      expect(foundKeys.length).toBe(10);
    });

    it("should SCAN with pattern matching", async () => {
      await redis.set(`${TEST_KEY_PREFIX}scan:alpha:1`, "a1");
      await redis.set(`${TEST_KEY_PREFIX}scan:alpha:2`, "a2");
      await redis.set(`${TEST_KEY_PREFIX}scan:beta:1`, "b1");

      const foundKeys: string[] = [];
      let cursor = "0";

      do {
        const [newCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${TEST_KEY_PREFIX}scan:alpha:*`,
          "COUNT",
          100,
        );
        cursor = newCursor;
        foundKeys.push(...keys);
      } while (cursor !== "0");

      expect(foundKeys.length).toBe(2);
      expect(foundKeys.every(k => k.includes("alpha"))).toBe(true);
    });

    it("should SSCAN iterate through set members", async () => {
      const key = `${TEST_KEY_PREFIX}sscan:set`;

      // Add many members
      const members = Array.from({ length: 20 }, (_, i) => `member${i}`);
      await redis.sadd(key, ...members);

      const foundMembers: string[] = [];
      let cursor = "0";

      do {
        const [newCursor, scannedMembers] = await redis.sscan(
          key,
          cursor,
          "COUNT",
          10,
        );
        cursor = newCursor;
        foundMembers.push(...scannedMembers);
      } while (cursor !== "0");

      expect(foundMembers.length).toBe(20);
    });
  });

  describe("Distributed Locking (Redlock) - used by concurrency control", () => {
    let redlock: Redlock;
    let redlockRedis: Redis;

    beforeAll(() => {
      // Create a dedicated Redis connection for Redlock to avoid closing the shared connection
      redlockRedis = new Redis(config.REDIS_URL!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      redlock = new Redlock([redlockRedis], {
        driftFactor: 0.01,
        retryCount: 3,
        retryDelay: 200,
        retryJitter: 200,
        automaticExtensionThreshold: 500,
      });
    });

    afterAll(async () => {
      // Don't call redlock.quit() as it closes the Redis clients passed to it
      // Just close our dedicated connection directly
      await redlockRedis.quit();
    });

    it("should acquire and release a lock", async () => {
      const resource = `${TEST_KEY_PREFIX}lock:basic`;
      const ttl = 10000;

      const lock = await redlock.acquire([resource], ttl);

      expect(lock).toBeDefined();
      expect(lock.resources).toContain(resource);

      await lock.release();

      // Verify lock is released by acquiring again immediately
      const newLock = await redlock.acquire([resource], ttl);
      expect(newLock).toBeDefined();
      await newLock.release();
    });

    it("should fail to acquire already held lock", async () => {
      const resource = `${TEST_KEY_PREFIX}lock:contention`;
      const ttl = 10000;

      const lock1 = await redlock.acquire([resource], ttl);

      // Create a second redlock instance with no retries (uses same connection)
      const redlock2 = new Redlock([redlockRedis], {
        retryCount: 0,
      });

      await expect(redlock2.acquire([resource], ttl)).rejects.toThrow();

      await lock1.release();
    });

    it("should extend lock TTL", async () => {
      const resource = `${TEST_KEY_PREFIX}lock:extend`;
      const ttl = 5000;

      const lock = await redlock.acquire([resource], ttl);

      // Extend the lock
      const extendedLock = await lock.extend(10000);

      expect(extendedLock).toBeDefined();

      await extendedLock.release();
    });

    it("should handle using() pattern for automatic release", async () => {
      const resource = `${TEST_KEY_PREFIX}lock:using`;
      let lockAcquired = false;

      await redlock.using([resource], 5000, async () => {
        lockAcquired = true;
      });

      expect(lockAcquired).toBe(true);

      // Verify lock was released
      const newLock = await redlock.acquire([resource], 5000);
      expect(newLock).toBeDefined();
      await newLock.release();
    });
  });

  describe("TTL Operations - used throughout codebase", () => {
    it("should TTL return remaining time", async () => {
      const key = `${TEST_KEY_PREFIX}ttl:basic`;
      await redis.set(key, "value", "EX", 60);

      const ttl = await redis.ttl(key);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it("should TTL return -1 for key without expiry", async () => {
      const key = `${TEST_KEY_PREFIX}ttl:no-expiry`;
      await redis.set(key, "value");

      const ttl = await redis.ttl(key);

      expect(ttl).toBe(-1);
    });

    it("should TTL return -2 for non-existent key", async () => {
      const key = `${TEST_KEY_PREFIX}ttl:nonexistent`;

      const ttl = await redis.ttl(key);

      expect(ttl).toBe(-2);
    });

    it("should PTTL return milliseconds", async () => {
      const key = `${TEST_KEY_PREFIX}pttl:basic`;
      await redis.set(key, "value", "PX", 60000);

      const pttl = await redis.pttl(key);

      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(60000);
    });

    it("should PERSIST remove expiry", async () => {
      const key = `${TEST_KEY_PREFIX}persist:basic`;
      await redis.set(key, "value", "EX", 60);

      const result = await redis.persist(key);
      const ttl = await redis.ttl(key);

      expect(result).toBe(1);
      expect(ttl).toBe(-1);
    });
  });

  describe("KEYS Operations - used for cleanup", () => {
    it("should KEYS return matching keys", async () => {
      await redis.set(`${TEST_KEY_PREFIX}keys:a`, "1");
      await redis.set(`${TEST_KEY_PREFIX}keys:b`, "2");
      await redis.set(`${TEST_KEY_PREFIX}keys:c`, "3");

      const keys = await redis.keys(`${TEST_KEY_PREFIX}keys:*`);

      expect(keys.length).toBe(3);
    });

    it("should EXISTS check key existence", async () => {
      const key = `${TEST_KEY_PREFIX}exists:test`;
      await redis.set(key, "value");

      const exists = await redis.exists(key);
      const notExists = await redis.exists(
        `${TEST_KEY_PREFIX}exists:nonexistent`,
      );

      expect(exists).toBe(1);
      expect(notExists).toBe(0);
    });

    it("should EXISTS check multiple keys", async () => {
      await redis.set(`${TEST_KEY_PREFIX}exists:a`, "1");
      await redis.set(`${TEST_KEY_PREFIX}exists:b`, "2");

      const count = await redis.exists(
        `${TEST_KEY_PREFIX}exists:a`,
        `${TEST_KEY_PREFIX}exists:b`,
        `${TEST_KEY_PREFIX}exists:nonexistent`,
      );

      expect(count).toBe(2);
    });
  });
});
