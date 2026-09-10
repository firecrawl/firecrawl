import { createHash } from "node:crypto";
import type { Logger } from "winston";
import type { forwardToExchange } from "../../lib/exchange-proxy";
import { getRedisConnection } from "../queue-service";

type Upstream = Awaited<ReturnType<typeof forwardToExchange>>;
export const MAX_REPLAY_BYTES = 5 * 1024 * 1024;

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
      (await redis.set(
        key,
        JSON.stringify({
          payloadHash,
          state: "pending",
          chargeId,
          teamId: input.teamId,
          createdAt: Date.now(),
        }),
        "NX",
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
      await redis.del(key);
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
      const stored = JSON.stringify({
        payloadHash,
        state: "complete",
        response,
      });
      if (Buffer.byteLength(stored) <= MAX_REPLAY_BYTES)
        await redis.set(key, stored, "EX", 86400);
      else
        await redis.set(
          key,
          JSON.stringify({ payloadHash, state: "complete" }),
          "EX",
          86400,
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
    await redis.set(
      key,
      JSON.stringify({ payloadHash, state: "pending", reconciliation }),
    );
  };
  return { chargeId, forget, finish, preserve };
}
