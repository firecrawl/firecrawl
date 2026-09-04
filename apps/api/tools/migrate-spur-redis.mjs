/**
 * Copy Spur string keys without deleting source keys or replacing newer data.
 * SOURCE_REDIS_URL=... TARGET_REDIS_URL=... node tools/migrate-spur-redis.mjs
 * Add --execute to copy, or --verify to compare. Default: read-only inventory.
 * Re-run --execute after application cutover to reconcile late source writes.
 */
import Redis from "ioredis";
import { pathToFileURL } from "node:url";

const prefixes = ["spur_context:", "spur_context_failed:", "spur_lock:"];
// Atomically capture value and absolute expiration using the source clock.
const readScript = `
local value = redis.call('GET', KEYS[1])
if not value then return {} end
local ttl = redis.call('PTTL', KEYS[1])
local now = redis.call('TIME')
local expires = -1
if ttl >= 0 then expires = now[1] * 1000 + math.floor(now[2] / 1000) + ttl end
return {value, expires}
`;

function checked(replies) {
  if (!replies) throw new Error("Pipeline returned no replies");
  return replies.map(([error, value]) => {
    if (error) throw error;
    return value;
  });
}

export async function migrate(
  source,
  target,
  {
    mode = "inventory",
    batchSize = 1000,
    pauseMs = 10,
    report = console.log,
  } = {},
) {
  if (!["inventory", "execute", "verify"].includes(mode))
    throw new Error("Invalid mode");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Invalid batch size");
  const [sourceInfo, targetInfo] = await Promise.all([
    source.info("replication"),
    target.info("replication"),
  ]);
  const runId = info => /^master_replid:(.+)$/m.exec(info)?.[1]?.trim();
  if (
    !runId(sourceInfo) ||
    !runId(targetInfo) ||
    runId(sourceInfo) === runId(targetInfo)
  ) {
    throw new Error("Source and target must be distinct server instances");
  }
  const stats = {
    scanned: 0,
    matched: 0,
    copied: 0,
    existing: 0,
    expired: 0,
    missing: 0,
    different: 0,
    ttlDifferent: 0,
    ignored: 0,
  };
  let cursor = "0";
  let lastReport = Date.now();
  do {
    const page = await source.scan(cursor, "MATCH", "spur_*", "COUNT", 2000);
    cursor = page[0];
    stats.scanned += page[1].length;
    const keys = page[1].filter(key =>
      prefixes.some(prefix => key.startsWith(prefix)),
    );
    stats.ignored += page[1].length - keys.length;
    stats.matched += keys.length;
    for (
      let offset = 0;
      mode !== "inventory" && offset < keys.length;
      offset += batchSize
    ) {
      const batch = keys.slice(offset, offset + batchSize);
      const read = source.pipeline();
      for (const key of batch) read.evalBuffer(readScript, 1, key);
      const values = checked(await read.exec());
      if (mode === "execute") {
        const write = target.pipeline();
        let queued = 0;
        for (let i = 0; i < batch.length; i++) {
          if (values[i].length === 0) {
            stats.expired++;
            continue;
          }
          const [value, expires] = values[i];
          if (expires >= 0) write.set(batch[i], value, "PXAT", expires, "NX");
          else write.set(batch[i], value, "NX");
          queued++;
        }
        if (queued)
          for (const result of checked(await write.exec())) {
            if (result === "OK") stats.copied++;
            else stats.existing++;
          }
      } else if (mode === "verify") {
        const readTarget = target.pipeline();
        for (const key of batch) readTarget.evalBuffer(readScript, 1, key);
        const destination = checked(await readTarget.exec());
        const now = await target.time();
        const nowMs = Number(now[0]) * 1000 + Math.floor(Number(now[1]) / 1000);
        for (let i = 0; i < batch.length; i++) {
          const value = values[i];
          if (value.length === 0 || (value[1] >= 0 && value[1] <= nowMs)) {
            stats.expired++;
            continue;
          }
          if (destination[i].length === 0) {
            stats.missing++;
            continue;
          }
          if (!value[0].equals(destination[i][0])) stats.different++;
          if (
            (value[1] === -1) !== (destination[i][1] === -1) ||
            Math.abs(value[1] - destination[i][1]) > 50
          )
            stats.ttlDifferent++;
        }
      }
      if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
    if (Date.now() - lastReport > 10000) {
      report(JSON.stringify({ mode, ...stats }));
      lastReport = Date.now();
    }
  } while (cursor !== "0");
  report(JSON.stringify({ mode, complete: true, ...stats }));
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(arg => !["--execute", "--verify"].includes(arg)) ||
    args.length > 1
  )
    throw new Error("Use no flag, --execute, or --verify");
  if (!process.env.SOURCE_REDIS_URL || !process.env.TARGET_REDIS_URL)
    throw new Error("Set SOURCE_REDIS_URL and TARGET_REDIS_URL");
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 10000,
    commandTimeout: 30000,
    retryStrategy: () => null,
  };
  const source = new Redis(process.env.SOURCE_REDIS_URL, options);
  const target = new Redis(process.env.TARGET_REDIS_URL, options);
  // Do not print endpoints, keys, values, or connection error messages.
  source.on("error", () => {});
  target.on("error", () => {});
  try {
    await Promise.all([source.connect(), target.connect()]);
    const result = await migrate(source, target, {
      mode: args[0]?.slice(2) ?? "inventory",
    });
    if (result.missing || result.different || result.ttlDifferent)
      process.exitCode = 2;
  } finally {
    source.disconnect();
    target.disconnect();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(
      "Migration failed; source keys were not deleted. Check connectivity and rerun.",
    );
    process.exitCode = 1;
  });
}
