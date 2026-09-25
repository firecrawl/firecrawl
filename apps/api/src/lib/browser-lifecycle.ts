import { z } from "zod";
import { orgIdForTeam } from "./team-org";
import { recordRequestCredits } from "./request-credits-store";
import { upsertBrowserProfile } from "./browser-sessions";
import { v7 as uuidv7 } from "uuid";
import { config } from "../config";
import { RequestWithAuth } from "../controllers/v2/types";
import {
  createHangarBrowser,
  getHangarBrowser,
  stopHangarBrowser,
  HangarBrowser,
  HangarError,
} from "./hangar";
import {
  insertBrowserSession,
  activateBrowserSession,
  completeBrowserSessionSettlement,
  markBrowserSessionUsedPrompt,
  settleBrowserSessionOnce,
  invalidateActiveBrowserSessionCount,
  didBrowserSessionUsePrompt,
  listUnsettledHangarSessions,
  BrowserSessionRow,
} from "./browser-sessions";
import {
  calculateBrowserSessionCredits,
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
} from "./browser-billing";
import { getEffectiveConcurrencyLimit } from "./concurrency-limit";
import {
  reserveExternalSlot,
  mirrorExternalSlotRelease,
} from "../services/worker/nuq-router";
import { autumnService } from "../services/autumn/autumn.service";
import { billTeam } from "../services/billing/credit_billing";
import { logRequest } from "../services/logging/log_job";
import { externalRequestId } from "./external-request-id";
import {
  updateKeylessBrowserCredits,
  logKeylessCreditUsage,
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
} from "./keyless";
import { logger } from "./logger";
import { redlock } from "../services/redlock";
import { redisRateLimitClient } from "../services/rate-limiter";

export function browserSessionLinks(session: BrowserSessionRow) {
  return {
    cdpUrl: session.cdp_url,
    liveViewUrl: session.cdp_path ?? "",
    interactiveLiveViewUrl: session.cdp_interactive_path ?? "",
    ...(session.context_id ? { playlistUrl: session.context_id } : {}),
  };
}

export async function createBrowserSession(
  req: RequestWithAuth<any, any, any>,
  options: {
    ttl: number;
    activityTtl: number;
    streamWebView: boolean;
    recordSession: boolean;
    profile?: { name: string; saveChanges: boolean };
    scrapeId?: string;
    shouldBill?: boolean;
    requestId?: string;
    initialize?: (browserId: string) => Promise<void>;
  },
) {
  if (!config.HANGAR_URL)
    throw new HangarError(
      503,
      "Browser feature is not configured (HANGAR_URL is missing).",
    );
  const shouldBill = options.shouldBill ?? true;
  const estimatedCredits = shouldBill
    ? calculateBrowserSessionCredits(options.ttl * 1000)
    : 0;
  const limit = await getEffectiveConcurrencyLimit(
    req.auth.team_id,
    req.acuc?.org_id ?? null,
  );
  if (shouldBill && req.acuc?.org_id) {
    const credit = await autumnService.checkCredits({
      teamId: req.auth.team_id,
      orgId: req.acuc.org_id,
      value: estimatedCredits,
      properties: {
        source: "browserCreate",
        path: req.path,
        apiKeyId: req.acuc?.api_key_id ?? null,
      },
    });
    if (credit !== null && !credit.allowed)
      throw new HangarError(
        402,
        `Insufficient credits for a ${options.ttl}s browser session (requires ~${estimatedCredits} credits).`,
      );
  }
  const id = uuidv7();
  let browserId: string | undefined;
  try {
    if (
      !(await reserveExternalSlot(
        req.auth.team_id,
        id,
        (options.ttl + 300) * 1000,
        limit,
      ))
    )
      throw new HangarError(
        429,
        `You have reached the maximum number of concurrent jobs (${limit}).`,
      );
    if (
      !(await updateKeylessBrowserCredits(
        req.auth.team_id,
        id,
        estimatedCredits,
      ))
    )
      throw new HangarError(429, KEYLESS_FREE_TIER_LIMIT_MESSAGE);
    const browser = await createHangarBrowser(id, req.auth.team_id, options);
    browserId = browser.id;
    if (!options.requestId)
      await logRequest({
        id,
        kind: options.scrapeId ? "interact" : "browser",
        api_version: "v2",
        external_request_id: externalRequestId(req),
        team_id: req.auth.team_id,
        target_hint: "Browser session",
        origin: req.body?.origin ?? "api",
        integration: req.body?.integration ?? null,
        zeroDataRetention: false,
        api_key_id: req.acuc?.api_key_id ?? null,
      });
    await insertBrowserSession({
      id,
      team_id: req.auth.team_id,
      request_id: options.requestId ?? id,
      should_bill: false,
      scrape_id: options.scrapeId,
      browser_id: browser.id,
      workspace_id: "",
      context_id: browser.playlist_url ?? "",
      cdp_url: browser.cdp_url,
      cdp_path: browser.view_url ?? "",
      cdp_interactive_path: browser.control_url ?? "",
      stream_web_view: options.streamWebView,
      status: "active",
      ttl_total: options.ttl,
      ttl_without_activity: options.activityTtl,
      credits_used: null,
      profile_name: options.profile?.name ?? null,
    });
    if (options.initialize) {
      await options.initialize(browser.id);
    }
    const session = await activateBrowserSession(id, shouldBill);
    await invalidateActiveBrowserSessionCount(req.auth.team_id);
    return {
      session,
      expiresAt:
        browser.max_expires_at === null
          ? undefined
          : new Date(browser.max_expires_at * 1000).toISOString(),
    };
  } catch (error) {
    if (browserId) await stopHangarBrowser(browserId).catch(() => {});
    await mirrorExternalSlotRelease(req.auth.team_id, id).catch(error =>
      logger.error("Failed to release browser reservation", {
        sessionId: id,
        error,
      }),
    );
    await updateKeylessBrowserCredits(req.auth.team_id, id, 0, true).catch(
      error =>
        logger.error("Failed to refund browser reservation", {
          sessionId: id,
          error,
        }),
    );
    throw error;
  }
}

export async function settleBrowserSession(
  session: BrowserSessionRow,
  browser: HangarBrowser,
) {
  if (browser.status !== "stopped" && browser.status !== "failed") return;
  if (
    !Number.isFinite(browser.ended_at) ||
    !Number.isFinite(browser.created_at) ||
    browser.ended_at! < browser.created_at
  )
    throw new HangarError(
      502,
      "Hangar did not return a valid session duration.",
    );
  if (
    session.profile_name &&
    browser.profile_saved_at &&
    z.uuid().safeParse(session.team_id).success
  ) {
    const savedAt = new Date(browser.profile_saved_at * 1000).toISOString();
    await upsertBrowserProfile({
      teamId: session.team_id,
      name: session.profile_name,
      savedAt,
      sizeBytes: undefined,
    });
  }
  const sessionDurationMs = (browser.ended_at! - browser.created_at) * 1000;
  const { creditsBilled } = await settleBrowserSessionOnce(
    session.id,
    async current => {
      const usedPrompt = await didBrowserSessionUsePrompt(current.id);
      const credits = current.should_bill
        ? calculateBrowserSessionCredits(
            sessionDurationMs,
            usedPrompt ? INTERACT_CREDITS_PER_HOUR : BROWSER_CREDITS_PER_HOUR,
          )
        : 0;
      const agentRequestId =
        current.request_id && current.request_id !== current.id
          ? current.request_id
          : undefined;
      if (current.should_bill) {
        const result = await billTeam(
          current.team_id,
          await orgIdForTeam(current.team_id),
          credits,
          null,
          {
            endpoint: agentRequestId
              ? "agent"
              : usedPrompt || current.scrape_id
                ? "interact"
                : "browser",
            jobId: agentRequestId ?? current.id,
            chargeId: `${current.id}:destroy`,
          },
        );
        if (!result.success) throw new Error("Browser billing was not queued.");
      }
      if (agentRequestId) {
        await recordRequestCredits({
          requestId: agentRequestId,
          jobId: current.id,
          credits,
        });
      }
      return credits;
    },
  );
  await finalizeBrowserSession(session, creditsBilled);
  return { sessionDurationMs, creditsBilled };
}

async function finalizeBrowserSession(
  session: BrowserSessionRow,
  credits: number,
) {
  await updateKeylessBrowserCredits(session.team_id, session.id, credits, true);
  await mirrorExternalSlotRelease(session.team_id, session.id);
  if (await completeBrowserSessionSettlement(session.id))
    await logKeylessCreditUsage(session.team_id, credits);
  await invalidateActiveBrowserSessionCount(session.team_id);
}

export async function reserveBrowserPromptCredits(
  req: RequestWithAuth<any, any, any>,
  session: BrowserSessionRow,
) {
  // This flag determines the billing rate. A failed read or write must not
  // silently execute a prompt at the cheaper browser rate.
  if (await didBrowserSessionUsePrompt(session.id)) return;
  if (session.should_bill) {
    const credits = calculateBrowserSessionCredits(
      session.ttl_total * 1000,
      INTERACT_CREDITS_PER_HOUR,
    );
    if (req.acuc?.org_id) {
      const credit = await autumnService.checkCredits({
        teamId: session.team_id,
        orgId: req.acuc.org_id,
        value: credits,
        properties: {
          source: "browserPrompt",
          path: req.path,
          apiKeyId: req.acuc?.api_key_id ?? null,
        },
      });
      if (credit !== null && !credit.allowed)
        throw new HangarError(
          402,
          "Insufficient credits for a browser prompt session.",
        );
    }
    if (
      !(await updateKeylessBrowserCredits(session.team_id, session.id, credits))
    )
      throw new HangarError(429, KEYLESS_FREE_TIER_LIMIT_MESSAGE);
  }
  await markBrowserSessionUsedPrompt(session.id);
}

export async function stopBrowserSession(session: BrowserSessionRow) {
  if (session.status === "destroyed") {
    return {
      success: true,
      status: "stopped",
      cleanupQueued: true,
      creditsBilled: session.credits_used ?? 0,
    };
  }
  let browser = await stopHangarBrowser(session.browser_id);
  if (!["stopping", "stopped", "failed"].includes(browser.status))
    throw new HangarError(502, "Hangar did not confirm the stop request.");
  // A successful public DELETE includes final duration and billing, even
  // though Hangar's stop endpoint acknowledges cleanup asynchronously.
  const deadline = Date.now() + 30_000;
  while (browser.status === "stopping") {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new HangarError(
        502,
        "Browser is still stopping. Retry deletion shortly.",
      );
    browser = await getHangarBrowser(
      session.browser_id,
      0,
      Math.min(remaining, 5000),
    );
    if (browser.status === "stopping")
      await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (browser.status !== "stopped" && browser.status !== "failed")
    throw new HangarError(502, "Hangar did not confirm session release.");
  const settled = await settleBrowserSession(session, browser);
  return {
    success: true,
    status: browser.status,
    cleanupQueued: true,
    ...settled,
  };
}

let reconciling = false;
export async function reconcileBrowserSessions() {
  if (!config.HANGAR_URL || reconciling) return;
  reconciling = true;
  let acquired = false;
  try {
    await redlock.using(
      ["browser:reconcile:lock"],
      60_000,
      { retryCount: 0 },
      async signal => {
        acquired = true;
        const nextRun = Number(
          await redisRateLimitClient.get("browser:reconcile:next"),
        );
        if (nextRun > Date.now()) return;
        await redisRateLimitClient.set(
          "browser:reconcile:next",
          Date.now() + 15_000,
          "EX",
          60,
        );
        // Fix the end of each sweep so new sessions cannot indefinitely
        // postpone retrying older sessions. Failed rows retain their backoff.
        const scanKey = "browser:reconcile:scan";
        const cursor = await redisRateLimitClient.hgetall(scanKey);
        const { sessions, through } = await listUnsettledHangarSessions(cursor);
        const results = await Promise.allSettled(
          sessions.map(async session => {
            const key = `browser:reconcile:${session.id}`;
            const state = await redisRateLimitClient.hgetall(key);
            if (Number(state.next) > Date.now() || signal.aborted) return;
            let failures = 0;
            try {
              // The persisted receipt lets quota reconciliation retry independently
              // of Hangar availability and recording/session metadata retention.
              if (session.credits_used !== null) {
                await finalizeBrowserSession(session, session.credits_used);
              } else {
                await settleBrowserSession(
                  session,
                  await getHangarBrowser(session.browser_id, 0, 5000),
                );
              }
            } catch (error) {
              failures = Math.min(Number(state.failures ?? 0) + 1, 5);
              logger.error("Failed to reconcile Hangar session", {
                sessionId: session.id,
                error,
              });
            }
            await redisRateLimitClient.hset(key, {
              failures,
              next: Date.now() + Math.min(300_000, 30_000 * 2 ** failures),
            });
            await redisRateLimitClient.expire(key, 2 * 86400);
          }),
        );
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        if (signal.aborted) throw signal.error;
        const lastId = sessions.at(-1)?.id;
        if (lastId && through && lastId !== through) {
          await redisRateLimitClient.hset(scanKey, { after: lastId, through });
        } else {
          await redisRateLimitClient.del(scanKey);
        }
      },
    );
  } catch (error) {
    // Other replicas normally own the lease; only log failures after acquiring it.
    if (acquired)
      logger.error("Failed to reconcile browser sessions", { error });
  } finally {
    reconciling = false;
  }
}
