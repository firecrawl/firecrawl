import { config } from "../config";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { getRedisConnection } from "../services/queue-service";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../services/autumn/autumn.service";
import { startBillingBatchProcessing } from "../services/billing/batch_billing";
import { toAutumnBillingProperties } from "../services/billing/types";
import {
  clearBrowserSessionPromptFlag,
  didBrowserSessionUsePrompt,
} from "./browser-sessions";
import { adjustKeylessCredits } from "./keyless";
import {
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
  calculateBrowserSessionCredits,
} from "./browser-billing";

const planSchema = z.object({
  teamId: z.string(),
  credits: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  usedPrompt: z.boolean(),
  rate: z.number(),
  apiKeyId: z.number().nullable(),
  shouldBill: z.boolean(),
  keylessDelta: z.number().nullable(),
  firebill: z.boolean(),
  billing: z.object({
    endpoint: z.enum(["browser", "interact", "agent"]),
    jobId: z.string(),
    chargeId: z.string(),
  }),
});

// The receipt and frozen intent deliberately have no TTL: completion can be
// retried long after a request failed or a process stopped.
const enqueueOnce = `
local receiptType = redis.call('TYPE', KEYS[1]).ok
local queueType = redis.call('TYPE', KEYS[2]).ok
if receiptType ~= 'hash' then return redis.error_reply('WRONGTYPE browser billing receipt') end
if queueType ~= 'none' and queueType ~= 'list' then return redis.error_reply('WRONGTYPE billing queue') end
if redis.call('HGET', KEYS[1], 'queued') == '1' then return 0 end
redis.call('HSET', KEYS[1], 'queued', '1')
local pushed = redis.pcall('RPUSH', KEYS[2], ARGV[1])
if type(pushed) == 'table' and pushed.err then
  redis.call('HDEL', KEYS[1], 'queued')
  return redis.error_reply(pushed.err)
end
return 1
`;

/** Serialize teardown and reconcile pending billing without repeating a queued charge. */
export async function finalizeBrowserSession(
  sessionId: string,
  durationMs: number,
  apiKeyId: number | null,
): Promise<{ creditsBilled: number; usedPrompt: boolean; rate: number }> {
  // Persist the pending teardown before any external charge. Creation rollback
  // only updates active rows and must not erase a charge awaiting completion.
  const destroyedAt = new Date().toISOString();
  await db
    .update(schema.browser_sessions)
    .set({
      status: "destroyed",
      updated_at: destroyedAt,
      deleted_at: destroyedAt,
    })
    .where(
      and(
        eq(schema.browser_sessions.id, sessionId),
        eq(schema.browser_sessions.status, "active"),
      ),
    );
  const result = await db.transaction(async tx => {
    const [session] = await tx
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.id, sessionId))
      .for("update");
    if (!session) throw new Error("Browser session not found during teardown");
    if (session.credits_used !== null) {
      return {
        creditsBilled: session.credits_used,
        usedPrompt: false,
        rate: 0,
      };
    }

    const redis = getRedisConnection();
    const key = `browser_session:billing:${sessionId}`;
    let raw = await redis.hget(key, "plan");
    if (raw === null) {
      const usedPrompt = await didBrowserSessionUsePrompt(sessionId);
      const rate = usedPrompt
        ? INTERACT_CREDITS_PER_HOUR
        : BROWSER_CREDITS_PER_HOUR;
      const credits = session.should_bill
        ? calculateBrowserSessionCredits(durationMs, rate)
        : 0;
      const agentId =
        session.request_id && session.request_id !== session.id
          ? session.request_id
          : null;
      const shouldBill =
        session.should_bill &&
        Boolean(config.USE_DB_AUTHENTICATION) &&
        session.team_id !== "preview" &&
        !session.team_id.startsWith("preview_");
      const plan: z.infer<typeof planSchema> = {
        teamId: session.team_id,
        credits,
        durationMs,
        usedPrompt,
        rate,
        apiKeyId,
        shouldBill,
        keylessDelta: session.scrape_id
          ? credits -
            calculateBrowserSessionCredits(
              session.ttl_total * 1000,
              BROWSER_CREDITS_PER_HOUR,
            )
          : null,
        firebill: shouldBill
          ? await autumnService.isRoutedThroughFirebill(session.team_id)
          : false,
        billing: {
          endpoint: agentId
            ? "agent"
            : session.scrape_id || usedPrompt
              ? "interact"
              : "browser",
          jobId: agentId ?? sessionId,
          chargeId: `browser-session:${sessionId}`,
        },
      };
      await redis.hsetnx(key, "plan", JSON.stringify(plan));
      raw = await redis.hget(key, "plan");
    }
    const plan = planSchema.parse(JSON.parse(raw!));
    if (plan.teamId !== session.team_id)
      throw new Error("Browser billing intent team mismatch");
    // Database lock acquisition and the durable intent precede quota changes.
    if (
      plan.keylessDelta !== null &&
      (await redis.hget(key, "keylessDone")) !== "1"
    ) {
      await adjustKeylessCredits(
        plan.teamId,
        plan.keylessDelta,
        `${sessionId}:scrape-browser`,
        { persistentReceipt: `browser_session:keyless_billing:${sessionId}` },
      );
      await redis.hset(key, "keylessDone", "1");
    }
    if (plan.shouldBill && (await redis.hget(key, "queued")) !== "1") {
      let tracked = await redis.hget(key, "tracked");
      if (tracked === null) {
        if (
          (await redis.hget(key, "trackingStarted")) === "1" &&
          !plan.firebill
        ) {
          // Legacy tracking has no idempotency contract. Never guess whether an
          // interrupted external charge committed and risk charging it again.
          throw new Error(
            "Browser billing tracking outcome is unknown; reconciliation is required",
          );
        }
        try {
          await redis.hset(key, "trackingStarted", "1");
        } catch (error) {
          // No tracking call has started, even if the marker write committed.
          try {
            await redis.hdel(key, "trackingStarted");
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Billing tracking marker and cleanup failed",
            );
          }
          throw error;
        }
        const trackedInRequest = await autumnService.trackCredits(
          {
            teamId: plan.teamId,
            value: plan.credits,
            properties: {
              source: "billTeam",
              ...toAutumnBillingProperties(plan.billing),
              apiKeyId: plan.apiKeyId,
            },
            featureId: featureIdForBillingEndpoint(plan.billing.endpoint),
            idempotencyKey: `fc:track:${plan.billing.endpoint}:${plan.billing.chargeId}`,
          },
          { throwOnError: true, requireFirebill: plan.firebill },
        );
        tracked = trackedInRequest ? "1" : "0";
        await redis.hset(key, "tracked", tracked);
      }
      await redis.eval(
        enqueueOnce,
        2,
        key,
        "billing_batch",
        JSON.stringify({
          team_id: plan.teamId,
          credits: plan.credits,
          api_key_id: plan.apiKeyId,
          billing: plan.billing,
          is_extract: false,
          timestamp: new Date().toISOString(),
          autumnTrackInRequest: tracked === "1",
        }),
      );
      startBillingBatchProcessing();
    }
    const now = new Date().toISOString();
    await tx
      .update(schema.browser_sessions)
      .set({
        status: "destroyed",
        credits_used: plan.credits,
        updated_at: now,
        deleted_at: now,
      })
      .where(eq(schema.browser_sessions.id, sessionId));
    return {
      creditsBilled: plan.credits,
      usedPrompt: plan.usedPrompt,
      rate: plan.rate,
    };
  });
  // The row is committed before Redis cleanup. A retry clears the flag without
  // billing again, including when the previous commit response was lost.
  await clearBrowserSessionPromptFlag(sessionId);
  return result;
}

/** A persisted intent is created only after the browser release was confirmed. */
export async function getBrowserSessionBillingDuration(
  sessionId: string,
): Promise<number | null> {
  const raw = await getRedisConnection().hget(
    `browser_session:billing:${sessionId}`,
    "plan",
  );
  return raw === null ? null : planSchema.parse(JSON.parse(raw)).durationMs;
}
