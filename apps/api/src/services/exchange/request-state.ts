import { createHash } from "node:crypto";
import type { Logger } from "winston";
import type { forwardToExchange } from "../../lib/exchange-proxy";
import { getRedisConnection } from "../queue-service";

type Upstream = Awaited<ReturnType<typeof forwardToExchange>>;
export const MAX_REPLAY_BYTES = 5 * 1024 * 1024;
export const MANUAL_RECONCILIATION_KEY = "exchange:provider-manual:v2";
export const RECONCILIATION_KEY = "exchange:provider-reconciliation:v2";
export const REQUEST_RETENTION_SECONDS = 7 * 86400;
export const RECOVERY_DELAY_MS = 5 * 60 * 1000;

export async function saveExchangeRequest(
  key: string,
  record: unknown,
  pending: boolean,
) {
  await getRedisConnection().eval(
    `
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    if ARGV[3] == 'pending' then
      redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
    else
      redis.call('ZREM', KEYS[2], KEYS[1])
    end
    return 1
  `,
    2,
    key,
    RECONCILIATION_KEY,
    JSON.stringify(record),
    pending ? REQUEST_RETENTION_SECONDS : 86400,
    pending ? "pending" : "complete",
    Date.now() + RECOVERY_DELAY_MS,
  );
}

export async function markExchangeRequestForReview(
  key: string,
  record: object,
) {
  await getRedisConnection().eval(
    `
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('ZREM', KEYS[2], KEYS[1])
    redis.call('ZADD', KEYS[3], ARGV[3], KEYS[1])
    return 1
  `,
    3,
    key,
    RECONCILIATION_KEY,
    MANUAL_RECONCILIATION_KEY,
    JSON.stringify({ ...record, state: "manual" }),
    REQUEST_RETENTION_SECONDS,
    Date.now(),
  );
}

export async function forgetExchangeRequest(key: string) {
  await getRedisConnection().eval(
    `
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[2], KEYS[1])
    return 1
  `,
    2,
    key,
    RECONCILIATION_KEY,
  );
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return value;
}
export function refusal(status: number, error: string): Upstream {
  return {
    status,
    body: { success: false, error },
    contentType: "application/json",
    requestId: null,
  };
}

export async function beginExchangeRequest(input: {
  teamId: string;
  requestId: string;
  body: unknown;
  bypassBilling?: boolean;
  logger: Logger;
}) {
  const chargeId = hash([input.teamId, input.requestId]);
  const payloadHash = hash([
    canonical(input.body),
    input.bypassBilling === true,
  ]);
  const key = `exchange:provider-request:v2:${chargeId}`;
  const redis = getRedisConnection();
  try {
    if (
      (await redis.eval(
        `
        if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
          redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
          return 'OK'
        end
        return nil
      `,
        2,
        key,
        RECONCILIATION_KEY,
        JSON.stringify({
          payloadHash,
          state: "pending",
          chargeId,
          teamId: input.teamId,
          requestId: input.requestId,
          createdAt: Date.now(),
        }),
        REQUEST_RETENTION_SECONDS,
        Date.now() + RECOVERY_DELAY_MS,
      )) !== "OK"
    ) {
      const raw = await redis.get(key);
      if (!raw)
        return {
          response: refusal(
            409,
            "Request state changed. Retry with the same x-request-id.",
          ),
        };
      const previous = JSON.parse(raw);
      if (previous.payloadHash !== payloadHash)
        return {
          response: refusal(
            409,
            "This x-request-id belongs to a different request.",
          ),
        };
      if (previous.state === "complete" && previous.response)
        return { response: previous.response as Upstream };
      if (previous.state === "complete")
        return {
          response: refusal(
            409,
            "This request completed, but its response was too large to retain for replay. It will not execute again.",
          ),
        };
      if (previous.state === "manual")
        return {
          response: refusal(
            409,
            "The provider outcome requires manual reconciliation. Do not execute it again with a new x-request-id.",
          ),
        };
      return {
        response: refusal(
          409,
          "This request is still processing or awaiting reconciliation. Do not retry with a new x-request-id.",
        ),
      };
    }
  } catch {
    return {
      response: refusal(
        503,
        "Unable to establish request identity. Retry with the same x-request-id.",
      ),
    };
  }
  const forget = async () => {
    try {
      await forgetExchangeRequest(key);
      return true;
    } catch (error) {
      input.logger.warn("Exchange request identity cleanup failed", {
        chargeId,
        error,
      });
      return false;
    }
  };
  const finish = async (response: Upstream) => {
    response = { ...response, requestId: input.requestId };
    try {
      const record = { payloadHash, state: "complete", response };
      await saveExchangeRequest(
        key,
        Buffer.byteLength(JSON.stringify(record)) <= MAX_REPLAY_BYTES
          ? record
          : { payloadHash, state: "complete" },
        false,
      );
    } catch (error) {
      input.logger.error("Exchange result replay storage failed", {
        chargeId,
        error,
      });
      return refusal(
        503,
        "Result storage needs reconciliation. Retry only with the same x-request-id.",
      );
    }
    return response;
  };
  const reconciliation: Record<string, unknown> = {
    teamId: input.teamId,
    chargeId,
  };
  const preserve = async (
    phase: "reserve" | "executing" | "confirm" | "enqueue",
    details: Record<string, unknown>,
  ) => {
    Object.assign(reconciliation, { phase, ...details });
    await saveExchangeRequest(
      key,
      {
        payloadHash,
        state: "pending",
        requestId: input.requestId,
        reconciliation,
      },
      true,
    );
  };
  return { chargeId, forget, finish, preserve };
}
