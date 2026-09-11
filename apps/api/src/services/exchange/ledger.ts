import { randomUUID } from "node:crypto";
import type { BillingOperation } from "../billing/batch_billing";
import { getRedisConnection } from "../queue-service";
import { logger } from "../../lib/logger";
import { reportExchangeUsageBilling } from "./report";

const PENDING = "exchange:billing-pending";
const REVIEW = "exchange:billing-review";
const RETENTION_SECONDS = 604800;
const RECOVERY_MS = 300000;
const assertTypes = `
  local function requireType(key, expected)
    local actual = redis.call('TYPE', key).ok
    if actual ~= 'none' and actual ~= expected then error('Unexpected Exchange ledger key type') end
  end
`;
const keyFor = (op: BillingOperation) =>
  `exchange:billing-enqueued:${op.team_id}:${op.exchange_usage_request_id}`;

export async function enqueueExchangeLedger(op: BillingOperation) {
  const result = await getRedisConnection().eval(
    `
    ${assertTypes}
    requireType(KEYS[1], 'list')
    requireType(KEYS[2], 'string')
    requireType(KEYS[3], 'zset')
    requireType(KEYS[4], 'zset')
    local existing = redis.call('GET', KEYS[2])
    if existing then
      local ok, record = pcall(cjson.decode, existing)
      if not ok or type(record) ~= 'table' then
        local retained = cjson.decode(ARGV[1])
        retained.state = 'review'
        redis.call('SET', KEYS[2], cjson.encode(retained), 'EX', ARGV[2])
        redis.call('ZADD', KEYS[4], ARGV[4], KEYS[2])
        return 0
      end
      if record.state == 'queued' or record.state == 'committed' then return 1 end
      return 0
    end
    redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
    redis.call('RPUSH', KEYS[1], ARGV[3])
    redis.call('ZADD', KEYS[3], ARGV[4], KEYS[2])
    return 1
  `,
    4,
    "billing_batch",
    keyFor(op),
    PENDING,
    REVIEW,
    JSON.stringify({ state: "queued", operation: op }),
    RETENTION_SECONDS,
    JSON.stringify(op),
    Date.now() + RECOVERY_MS,
  );
  return result === 1;
}

export async function claimExchangeLedger(op: BillingOperation) {
  const token = randomUUID();
  const claimed = await getRedisConnection().eval(
    `
    ${assertTypes}
    requireType(KEYS[1], 'string')
    requireType(KEYS[2], 'zset')
    requireType(KEYS[3], 'zset')
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 0 end
    local ok, record = pcall(cjson.decode, raw)
    if not ok or type(record) ~= 'table' then
      redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[2])
      redis.call('ZADD', KEYS[3], ARGV[3], KEYS[1])
      return 0
    end
    if record.state ~= 'queued' then return 0 end
    record.state = 'processing'
    record.token = ARGV[1]
    redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
    return 1
  `,
    3,
    keyFor(op),
    PENDING,
    REVIEW,
    token,
    RETENTION_SECONDS,
    Date.now() + RECOVERY_MS,
    JSON.stringify({ state: "review", operation: op }),
  );
  return claimed === 1 ? token : null;
}

export async function finishExchangeLedger(
  op: BillingOperation,
  token: string,
  state: "committed" | "queued" | "review",
) {
  const saved = await getRedisConnection().eval(
    `
    ${assertTypes}
    requireType(KEYS[1], 'string')
    requireType(KEYS[2], 'zset')
    requireType(KEYS[3], 'zset')
    requireType(KEYS[4], 'list')
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 0 end
    local record = cjson.decode(raw)
    if record.token ~= ARGV[1] then return 0 end
    if record.state == 'committed' then return 2 end
    record.state = ARGV[2]
    redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ARGV[3])
    redis.call('ZREM', KEYS[2], KEYS[1])
    redis.call('ZREM', KEYS[3], KEYS[1])
    if ARGV[2] == 'review' then
      redis.call('ZADD', KEYS[3], ARGV[4], KEYS[1])
    else
      redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
      if ARGV[2] == 'queued' then redis.call('RPUSH', KEYS[4], cjson.encode(record.operation)) end
    end
    return 1
  `,
    4,
    keyFor(op),
    PENDING,
    REVIEW,
    "billing_batch",
    token,
    state,
    RETENTION_SECONDS,
    Date.now() + RECOVERY_MS,
  );
  if (saved !== 1 && saved !== 2)
    throw new Error("Exchange ledger checkpoint was not saved");
  if (state === "review" && saved === 1)
    logger.error("Exchange ledger outcome requires reconciliation", {
      key: keyFor(op),
      teamId: op.team_id,
      usageRequestId: op.exchange_usage_request_id,
    });
}

export async function confirmExchangeLedger(op: BillingOperation) {
  const confirmed = await reportExchangeUsageBilling(
    op.exchange_usage_request_id!,
    op.billing_reference,
  );
  if (confirmed) {
    try {
      await getRedisConnection().zrem(PENDING, keyFor(op));
    } catch (error) {
      logger.error("Exchange ledger acknowledgement will retry", {
        error,
        key: keyFor(op),
      });
    }
  }
  return confirmed;
}

// These PostgreSQL errors guarantee that the statement was rolled back.
export function isRetryableLedgerRollback(error: unknown) {
  const code = (error as { code?: string } | undefined)?.code;
  return code !== undefined && ["40001", "40P01", "55P03"].includes(code);
}

export async function recoverExchangeLedger() {
  const redis = getRedisConnection();
  await redis.zremrangebyscore(
    REVIEW,
    "-inf",
    Date.now() - RETENTION_SECONDS * 1000,
  );
  const keys = await redis.zrangebyscore(
    PENDING,
    "-inf",
    Date.now(),
    "LIMIT",
    0,
    50,
  );
  for (const key of keys) {
    try {
      const raw = await redis.eval(
        `
        ${assertTypes}
        requireType(KEYS[1], 'zset')
        requireType(KEYS[2], 'zset')
        requireType(KEYS[3], 'string')
        requireType(KEYS[4], 'list')
        local due = redis.call('ZSCORE', KEYS[1], KEYS[3])
        if not due or tonumber(due) > tonumber(ARGV[1]) then return nil end
        local raw = redis.call('GET', KEYS[3])
        if not raw then redis.call('ZREM', KEYS[1], KEYS[3]); return nil end
        local record = cjson.decode(raw)
        if record.state == 'processing' then
          record.state = 'review'
          redis.call('SET', KEYS[3], cjson.encode(record), 'EX', ARGV[3])
          redis.call('ZREM', KEYS[1], KEYS[3])
          redis.call('ZADD', KEYS[2], ARGV[1], KEYS[3])
        else
          redis.call('ZADD', KEYS[1], ARGV[2], KEYS[3])
          if record.state == 'queued' then redis.call('RPUSH', KEYS[4], cjson.encode(record.operation)) end
        end
        return cjson.encode(record)
      `,
        4,
        PENDING,
        REVIEW,
        key,
        "billing_batch",
        Date.now(),
        Date.now() + RECOVERY_MS,
        RETENTION_SECONDS,
      );
      if (!raw) continue;
      const record = JSON.parse(String(raw));
      if (record.state === "committed")
        await confirmExchangeLedger(record.operation);
      if (record.state === "review")
        logger.error("Exchange ledger outcome requires reconciliation", {
          key,
        });
    } catch (error) {
      logger.error("Exchange ledger recovery will retry", { key, error });
    }
  }
}
