import { createHash } from "node:crypto";
import { Job, Queue, QueueEvents, UnrecoverableError } from "bullmq";
import { z } from "zod";
import { config } from "../../config";
import { billTeam7 } from "../../db/rpc";
import { firebillConfigured, firebillFinalize } from "../autumn/firebill";
import { logger } from "../../lib/logger";
import { getEffectiveConcurrencyLimit } from "../../lib/concurrency-limit";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import { getRedisConnection } from "../queue-service";
import { teamConcurrencySemaphore } from "../worker/team-semaphore";
import { authorizeProviders } from "./access";
import { exchangeRequest } from "./client";
import {
  answerSchema,
  refusal,
  type ExchangeResponse,
  type ProviderAnswer,
  type ProviderCall,
} from "./contracts";

type Retrieval = {
  teamId: string;
  orgId?: string | null;
  apiKeyId: number | null;
  calls: ProviderCall[];
  fingerprint: string;
  deadline: number;
  billable: boolean;
  phase:
    | "new"
    | "reserving"
    | "held"
    | "executing"
    | "settling"
    | "recording"
    | "reporting"
    | "done";
  maximumCredits?: number;
  lockId?: string;
  operationToken?: string;
  answer?: ProviderAnswer;
  response?: ExchangeResponse;
};
const queueName = "{alexandriaQueue}";
let queue: Queue<Retrieval, ExchangeResponse>;
let events: QueueEvents;
export function getAlexandriaQueue() {
  return (queue ??= new Queue<Retrieval, ExchangeResponse>(queueName, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 7 * 86400 },
      removeOnFail: false,
    },
  }));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const pending = () =>
  refusal(
    503,
    "Provider request pending or awaiting reconciliation. Retry with the same x-request-id; do not create a new request.",
  );

export async function retrieveProviders(input: {
  teamId: string;
  orgId?: string | null;
  apiKeyId: number | null;
  calls: ProviderCall[];
  requestId: string;
  timeoutMs: number;
  bypassBilling?: boolean;
}): Promise<ExchangeResponse> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId))
    return refusal(
      400,
      "Invalid x-request-id; use 1-128 letters, digits, dots, underscores, colons or hyphens.",
    );
  if (Buffer.byteLength(JSON.stringify(input.calls)) > 256 * 1024)
    return refusal(400, "Provider options exceed 256 KB.");
  const denied = await authorizeProviders(input.teamId, input.calls);
  if (denied) return denied;
  const billable = !input.bypassBilling;
  const fingerprint = hash([input.calls, billable]);
  const jobId = hash([input.teamId, input.requestId]);
  const q = getAlexandriaQueue();
  await q.add(
    "retrieve",
    {
      teamId: input.teamId,
      orgId: input.orgId,
      apiKeyId: input.apiKeyId,
      calls: input.calls,
      fingerprint,
      deadline: Date.now() + input.timeoutMs,
      billable,
      phase: "new",
    },
    { jobId },
  );
  // add() also succeeds for an existing ID; only persisted data identifies its payload.
  const job = await q.getJob(jobId);
  if (!job) return pending();
  if (job.data.fingerprint !== fingerprint)
    return refusal(
      409,
      "This x-request-id already belongs to a different provider request.",
    );
  events ??= new QueueEvents(queueName, { connection: getRedisConnection() });
  try {
    return await job.waitUntilFinished(events, input.timeoutMs);
  } catch {
    return pending();
  }
}

export async function runProviderJob(
  job: Job<Retrieval, ExchangeResponse>,
): Promise<ExchangeResponse> {
  let state = job.data;
  const id = job.id!;
  const properties = {
    source: "alexandria",
    endpoint: "scrape",
    chargeId: id,
    apiKeyId: state.apiKeyId,
  };
  const featureId = featureIdForBillingEndpoint("scrape");
  const save = async (patch: Partial<Retrieval>) => {
    if (!job.token || (await job.extendLock(job.token, 60000)) !== 1)
      throw new UnrecoverableError(`Provider job lease lost: ${id}`);
    const next = { ...state, ...patch };
    await job.updateData(next);
    state = next;
  };
  const finish = async (response: ExchangeResponse) => {
    await save({ phase: "done", response, answer: undefined });
    return response;
  };
  const finalize = async (action: "confirm" | "release", credits?: number) => {
    if (!state.lockId) return;
    const params = {
      teamId: state.teamId,
      lockId: state.lockId,
      action,
      overrideValue: credits,
      externalRequestId: state.operationToken,
      heldValue: state.maximumCredits,
      featureId,
      properties,
    };
    const settled = state.operationToken
      ? Boolean(state.orgId) &&
        firebillConfigured() &&
        (await firebillFinalize({ ...params, customerId: state.orgId! }))
      : await autumnService.finalizeCreditsLock(params);
    if (!settled) throw new Error("Provider credit settlement is unavailable");
  };

  if (state.phase === "done") return state.response!;
  // A stalled owner can resume; only read-only or idempotent reporting may overlap it.
  if (job.stalledCounter > 0 && state.phase !== "reporting")
    throw new UnrecoverableError(
      `Stalled provider job requires reconciliation: ${id}`,
    );
  // These writes precede non-idempotent calls. A crash cannot prove whether they landed.
  if (["reserving", "executing", "recording"].includes(state.phase))
    throw new UnrecoverableError(
      `Provider ${state.phase} outcome requires reconciliation: ${id}`,
    );

  if (state.phase === "new" || state.phase === "held") {
    const denied = await authorizeProviders(state.teamId, state.calls);
    if (denied || Date.now() >= state.deadline) {
      await finalize("release");
      return finish(
        denied ?? refusal(504, "Provider request expired before execution."),
      );
    }
    if (state.phase === "new") {
      const quote = await exchangeRequest({
        teamId: state.teamId,
        path: "/v1/retrieve/quote",
        body: { requests: state.calls },
        timeoutMs: Math.min(10000, state.deadline - Date.now()),
      });
      if (quote.status !== 200) return finish(quote);
      const { maximumCredits } = z
        .object({
          maximumCredits: z
            .number()
            .int()
            .min(0)
            .max(state.calls.length * 100),
        })
        .parse(quote.body);
      await save({ maximumCredits });
      if (state.billable && maximumCredits > 0) {
        if (
          !config.USE_DB_AUTHENTICATION ||
          !config.EXCHANGE_INTERNAL_SECRET ||
          !config.FIRE_EXCHANGE_URL?.startsWith("https://")
        )
          return finish(
            refusal(
              503,
              "Paid provider billing is not configured. No provider was executed.",
            ),
          );
        await save({ phase: "reserving", lockId: `alexandria_${id}` });
        const hold = await autumnService.lockCredits({
          teamId: state.teamId,
          value: maximumCredits,
          lockId: state.lockId,
          expiresAt: Date.now() + 3600000,
          featureId,
          properties,
        });
        if (hold.status !== "locked") {
          if (hold.status === "skipped") await finalize("release");
          return finish(
            refusal(
              hold.status === "denied" && hold.reason !== "gate_unavailable"
                ? 402
                : 503,
              "Credit reservation failed. No provider was executed.",
            ),
          );
        }
        await save({
          phase: "held",
          lockId: hold.lockId.trim() || state.lockId,
          operationToken: hold.operationToken,
        });
      } else await save({ phase: "held" });
    }
    const timeout = state.deadline - Date.now();
    if (timeout <= 0) {
      await finalize("release");
      return finish(refusal(504, "Provider request expired before execution."));
    }
    const limit = await getEffectiveConcurrencyLimit(state.teamId, state.orgId);
    const response = await teamConcurrencySemaphore.withSemaphore(
      state.teamId,
      id,
      limit,
      AbortSignal.timeout(timeout),
      timeout,
      async () => {
        if (Date.now() >= state.deadline)
          throw new Error("Provider execution deadline exceeded");
        await save({ phase: "executing" });
        if (Date.now() >= state.deadline)
          throw new Error("Provider execution deadline exceeded");
        return exchangeRequest({
          teamId: state.teamId,
          path: "/v1/retrieve",
          body: { requests: state.calls },
          timeoutMs: Math.max(1, state.deadline - Date.now()),
          requestId: id,
          maximumCredits: state.maximumCredits,
        });
      },
    );
    if (response.status < 200 || response.status >= 300) {
      // Definitive client refusals did not buy work. Server failures remain ambiguous.
      if (response.status >= 500)
        throw new UnrecoverableError(
          `Provider execution requires reconciliation: ${id}`,
        );
      await save({ phase: "settling", response });
    } else {
      const answer = answerSchema.parse(response.body);
      if (
        answer.results.length !== state.calls.length ||
        answer.creditsCost > state.maximumCredits! ||
        answer.results.reduce(
          (sum, item) => sum + (item.creditsCost ?? 0),
          0,
        ) !== answer.creditsCost ||
        answer.results.some(
          (item, i) =>
            (item.provider !== undefined &&
              item.provider !== state.calls[i].provider) ||
            (item.capability !== undefined &&
              item.capability !== state.calls[i].capability),
        )
      )
        throw new UnrecoverableError(`Invalid provider billing receipt: ${id}`);
      await save({ phase: "settling", answer });
    }
  }
  if (state.phase === "settling") {
    const credits = state.answer?.creditsCost ?? 0;
    await finalize(credits > 0 ? "confirm" : "release", credits);
    if (state.response) return finish(state.response);
    if (state.billable && credits > 0) {
      await save({ phase: "recording" });
      // This existing RPC is not idempotent. Never automatically repeat an uncertain insert.
      await billTeam7({
        team_id: state.teamId,
        subscription_id: null,
        credits,
        api_key_id: state.apiKeyId,
        is_extract: false,
      });
    }
    await save({ phase: "reporting" });
  }
  if (state.phase === "reporting") {
    if (state.billable) {
      const report = await exchangeRequest({
        teamId: state.teamId,
        path: "/v1/usage-events/billing",
        internal: true,
        timeoutMs: 5000,
        body: [
          {
            requestId: id,
            status: "confirmed",
            billingReference: `alexandria:${id}`,
          },
        ],
      });
      if (report.status !== 200)
        throw new Error("Provider billing report is pending");
    }
    return finish({ status: 200, body: state.answer! });
  }
  throw new UnrecoverableError(
    `Unexpected provider request state: ${state.phase}`,
  );
}

export async function processProviderJob(token: string, job: Job) {
  const renewal = setInterval(() => {
    void job.extendLock(token, 60000).catch(error =>
      logger.error("Provider job lock renewal failed", {
        jobId: job.id,
        error,
      }),
    );
  }, 10000);
  try {
    await job.moveToCompleted(await runProviderJob(job), token, false);
  } catch (error) {
    logger.error("Provider request failed or needs reconciliation", {
      jobId: job.id,
      phase: job.data.phase,
      error,
    });
    await job.moveToFailed(error as Error, token, false);
  } finally {
    clearInterval(renewal);
  }
}
