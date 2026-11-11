import { fetch } from "undici";
import { z } from "zod";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { exchangeRequest } from "../alexandria/client";
import type { ExchangeResponse } from "../alexandria/contracts";
import { autumnService } from "../autumn/autumn.service";
import { firebillConfigured } from "../autumn/firebill";
import type { LockCreditsResult } from "../autumn/types";
import { getBillingQueue, getRedisConnection } from "../queue-service";

/** Creating an order prices it from the published snapshot; every other call only touches the order. */
const CREATE_TIMEOUT_MS = 20_000;
const EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * How long a captured order is remembered, with the credits charged and the
 * billing reference reported for them. A charged order is only ever reported
 * as captured again, never released. The same record keeps its ledger job to
 * one: the billing queue forgets a finished job within minutes, so the job id
 * alone would let a repeated capture enqueue it again.
 */
const CAPTURE_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * A capture is not started this close to the hold's expiry, or after it: the
 * charge could arrive once the hold is gone. The order is left to expire, and
 * its hold to be released.
 */
const CAPTURE_MARGIN_MS = 2 * 60 * 1000;

const SETTLEMENT_DUE_STATUSES = new Set([
  "built",
  "failed",
  "cancelled",
  "expired",
]);

/** An error a dataset order route answers as `{ success: false, code, error }`. */
export class DatasetOrderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const unavailable = (status: 502 | 503 = 502) =>
  new DatasetOrderError(
    status,
    "datasets_unavailable",
    "Dataset orders are not available right now.",
  );

const orderSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  holdState: z.string(),
  holdCredits: z.int().positive(),
  holdExpiresAt: z.string(),
  credits: z.int().nullable(),
});
type DatasetOrder = z.infer<typeof orderSchema>;

const orderAnswerSchema = z.object({ order: orderSchema });
const createdAnswerSchema = z.object({
  order: orderSchema,
  existing: z.boolean(),
});
const readAnswerSchema = z.object({
  order: orderSchema,
  files: z.array(z.unknown()),
});
const settlementAnswerSchema = z.object({
  order: orderSchema,
  teamId: z.string().min(1),
  orgId: z.string().nullable(),
  apiKeyId: z.union([z.number(), z.string()]).nullable(),
  lockId: z.string().nullable(),
  due: z.enum(["capture", "release"]).nullable(),
});
const errorAnswerSchema = z.object({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    retryable: z.unknown().optional(),
  }),
});
const captureSchema = z.object({
  credits: z.int().positive(),
  billingReference: z.string().min(1),
});

const billingProperties = (orderId: string) => ({
  source: "datasetOrder",
  endpoint: "datasets",
  jobId: orderId,
});
const orderPath = (orderId: string, action: string) =>
  `/v1/datasets/orders/${encodeURIComponent(orderId)}/${action}`;

function assertConfigured() {
  if (!config.FIRE_EXCHANGE_URL || !config.EXCHANGE_INTERNAL_SECRET)
    throw unavailable(503);
}

/** A call only this API may make: it carries the internal secret, never a caller's identity. */
async function internalRequest(
  path: string,
  body?: unknown,
  timeoutMs = EXCHANGE_TIMEOUT_MS,
): Promise<ExchangeResponse> {
  const response = await fetch(
    config.FIRE_EXCHANGE_URL!.replace(/\/+$/, "") + path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-exchange-secret": config.EXCHANGE_INTERNAL_SECRET!,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/**
 * Reads an Exchange answer. A refusal passes through with its status, its code
 * and message, and the details it carried. A 401 does not: it refuses this
 * API's own credential, not the caller's.
 */
async function answerOf<T>(
  schema: z.ZodType<T>,
  request: Promise<ExchangeResponse>,
): Promise<T> {
  let response: ExchangeResponse;
  try {
    response = await request;
  } catch (error) {
    logger.error("Dataset order request did not complete", { error });
    throw unavailable();
  }
  if (response.status >= 200 && response.status < 300) {
    const answer = schema.safeParse(response.body);
    if (answer.success) return answer.data;
  } else if (response.status !== 401) {
    const refusal = errorAnswerSchema.safeParse(response.body);
    if (refusal.success) {
      const { code, message, retryable: _, ...details } = refusal.data.error;
      throw new DatasetOrderError(response.status, code, message, details);
    }
  }
  logger.error("Dataset order request got an unusable answer", {
    status: response.status,
  });
  throw unavailable();
}

/**
 * Places an order and holds its credits. An order is queued only once its
 * credits are really held: a hold that is denied, or that cannot be taken at
 * all, refuses the order.
 *
 * An order that needs no build is already built once its hold is recorded, so
 * it is settled in the same call and answered delivered. When that settle does
 * not go through, the built order is answered and its next read settles it.
 */
export async function createDatasetOrder(input: {
  teamId: string;
  orgId: string | null;
  apiKeyId: number | null;
  idempotencyKey: string;
  spec: Record<string, unknown>;
  maxCredits: number;
}): Promise<{ order: DatasetOrder; existing: boolean }> {
  assertConfigured();
  const { order, existing } = await answerOf(
    createdAnswerSchema,
    internalRequest("/v1/datasets/orders", input, CREATE_TIMEOUT_MS),
  );
  if (order.status !== "pending_hold") return { order, existing };

  if (order.holdCredits > input.maxCredits)
    throw new DatasetOrderError(
      409,
      "price_changed",
      `This order holds ${order.holdCredits} credits, above the ${input.maxCredits} the request allows.`,
      { holdCredits: order.holdCredits },
    );

  const expiresAt = Date.parse(order.holdExpiresAt);
  const lock: LockCreditsResult =
    input.orgId !== null && expiresAt > Date.now()
      ? await autumnService.lockCredits({
          teamId: input.teamId,
          orgId: input.orgId,
          value: order.holdCredits,
          lockId: `dataset_order_${order.id}`,
          expiresAt,
          properties: billingProperties(order.id),
        })
      : { status: "skipped" };

  if (lock.status === "locked") {
    const held = await answerOf(
      orderAnswerSchema,
      internalRequest(orderPath(order.id, "hold"), {
        outcome: "held",
        lockId: lock.lockId,
      }),
    );
    if (held.order.status !== "built") return { order: held.order, existing };
    try {
      return { order: await settleDatasetOrder(held.order.id), existing };
    } catch (error) {
      logger.warn("Dataset order was not settled when it was placed", {
        orderId: held.order.id,
        error,
      });
      return { order: held.order, existing };
    }
  }

  const outcome = lock.status === "denied" ? "denied" : "unavailable";
  await answerOf(
    orderAnswerSchema,
    internalRequest(orderPath(order.id, "hold"), { outcome }),
  ).catch(error =>
    logger.warn("Dataset order refusal was not recorded", {
      orderId: order.id,
      outcome,
      error,
    }),
  );
  throw outcome === "denied"
    ? new DatasetOrderError(
        402,
        "insufficient_credits",
        `Insufficient credits: this order holds ${order.holdCredits} credits.`,
      )
    : new DatasetOrderError(
        503,
        "billing_unavailable",
        "The credits for this order could not be held. Nothing was charged.",
      );
}

/**
 * Does what the Exchange says is due on an order's hold, and nothing else: a
 * capture of the built order's credits, or a release. Answers the order as it
 * stands afterwards. A settle the billing service did not accept leaves the
 * order as it is, for the next call to retry; so does a capture that would
 * start too close to the hold's expiry, and so does an instance where billing
 * is not configured. A hold that has already run out is gone by itself, so its
 * release is only reported.
 *
 * Charged means delivered: once a capture was accepted the order is reported
 * as captured on every later call, whatever is due by then, and never released.
 */
export async function settleDatasetOrder(id: string): Promise<DatasetOrder> {
  assertConfigured();
  const { order, teamId, orgId, apiKeyId, lockId, due } = await answerOf(
    settlementAnswerSchema,
    internalRequest(orderPath(id, "settlement")),
  );
  if (due === null) return order;

  const report = async (settled: Record<string, unknown>) =>
    (
      await answerOf(
        orderAnswerSchema,
        internalRequest(orderPath(order.id, "settled"), settled),
      )
    ).order;

  const marker = `dataset_order_captured:${order.id}`;
  const recorded = await getRedisConnection().get(marker);
  if (recorded !== null)
    return report({
      outcome: "captured",
      ...captureSchema.parse(JSON.parse(recorded)),
    });

  const { credits } = order;
  const unusable = () => {
    logger.error("Dataset order settlement does not fit its hold", {
      orderId: order.id,
      due,
      lockId,
      credits,
      holdCredits: order.holdCredits,
    });
    return unavailable();
  };
  if (lockId === null) throw unusable();

  // finalizeCreditsLock answers true where billing is not configured, because
  // no hold can have been taken there. This hold was taken elsewhere, so here
  // nothing would be captured or released, and nothing may be reported.
  if (!firebillConfigured()) {
    logger.error("Dataset order was not settled: billing is not configured", {
      orderId: order.id,
      due,
    });
    return order;
  }

  const properties = billingProperties(order.id);
  const team = orgId !== null ? { teamId, orgId } : undefined;

  if (due === "release") {
    const released =
      Date.now() > Date.parse(order.holdExpiresAt) ||
      (await autumnService.finalizeCreditsLock({
        lockId,
        action: "release",
        properties,
        team,
      }));
    return released ? report({ outcome: "released" }) : order;
  }

  if (credits === null || credits < 1 || credits > order.holdCredits)
    throw unusable();
  if (!(Date.now() < Date.parse(order.holdExpiresAt) - CAPTURE_MARGIN_MS)) {
    logger.warn("Dataset order was not captured: its hold is running out", {
      orderId: order.id,
      holdExpiresAt: order.holdExpiresAt,
    });
    return order;
  }
  const charged = await autumnService.finalizeCreditsLock({
    lockId,
    action: "confirm",
    overrideValue: credits,
    properties,
    team,
  });
  if (!charged) return order;

  const capture = {
    credits,
    billingReference: `dataset-order-bill-${order.id}`,
  };
  const first = await getRedisConnection().set(
    marker,
    JSON.stringify(capture),
    "EX",
    CAPTURE_MARKER_TTL_SECONDS,
    "NX",
  );
  if (first === "OK")
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await getBillingQueue().add(
          "bill_team",
          {
            team_id: teamId,
            org_id: orgId,
            credits,
            billing: { endpoint: "datasets", jobId: order.id },
            is_extract: false,
            timestamp: new Date().toISOString(),
            originating_job_id: order.id,
            api_key_id: typeof apiKeyId === "number" ? apiKeyId : null,
            // The worker refunds request-tracked credits when the ledger
            // write fails. These files stay delivered, so the charge stands.
            autumnTrackInRequest: false,
          },
          { jobId: capture.billingReference, priority: 10 },
        );
        break;
      } catch (error) {
        if (attempt < 3)
          await new Promise(resolve => setTimeout(resolve, 250 * attempt));
        else
          logger.error(
            "Dataset order ledger job was not enqueued; the charge stands",
            { orderId: order.id, teamId, credits, error },
          );
      }
    }

  return report({ outcome: "captured", ...capture });
}

/**
 * Reads a team's own order, settling its hold first when that is due. Another
 * team's order is the Exchange's 404, so only the buyer's read settles.
 */
export async function getDatasetOrder(
  teamId: string,
  id: string,
): Promise<{ order: DatasetOrder; files: unknown[] }> {
  assertConfigured();
  const read = () =>
    answerOf(
      readAnswerSchema,
      exchangeRequest({
        teamId,
        path: `/v1/platform/datasets/orders/${encodeURIComponent(id)}`,
        timeoutMs: EXCHANGE_TIMEOUT_MS,
        retryConnection: true,
      }),
    );
  const view = await read();
  if (
    view.order.holdState !== "held" ||
    !SETTLEMENT_DUE_STATUSES.has(view.order.status)
  )
    return view;

  try {
    const settled = await settleDatasetOrder(view.order.id);
    if (settled.holdState === "held") return view;
  } catch (error) {
    logger.warn("Dataset order was not settled on read", {
      orderId: view.order.id,
      error,
    });
    return view;
  }
  return read();
}
