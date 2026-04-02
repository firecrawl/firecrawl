import { createHash } from "crypto";
import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  insertBrowserSession,
  getBrowserSession,
  updateBrowserSessionActivity,
  updateBrowserSessionCreditsUsed,
  updateBrowserSessionScrapeId,
  claimBrowserSessionDestroyed,
  invalidateActiveBrowserSessionCount,
  getBrowserSessionFromScrape,
  markBrowserSessionUsedPrompt,
  didBrowserSessionUsePrompt,
  clearBrowserSessionPromptFlag,
} from "../../lib/browser-sessions";
import {
  getConcurrencyLimitActiveJobsCount,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
import {
  browserServiceRequest,
  BrowserServiceError,
  BrowserServiceExecResponse,
  BrowserServiceCreateResponse,
  BrowserServiceDeleteResponse,
} from "../../lib/scrape-interact/browser-service-client";
import {
  ScrapeContextRow,
  buildReplayContextFromScrape,
  estimateReplayTimeoutSeconds,
  buildReplayScript,
} from "../../lib/scrape-interact/scrape-replay";
import {
  executePromptViaBrowserAgent,
  AgentResult,
} from "../../lib/scrape-interact/browser-agent";
import { RequestWithAuth, ScrapeOptions } from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
import { logRequest } from "../../services/logging/log_job";
import { integrationSchema } from "../../utils/integration";
import { supabaseGetScrapeById } from "../../lib/supabase-jobs";
import {
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
  calculateBrowserSessionCredits,
} from "../../lib/browser-billing";
import { autumnService } from "../../services/autumn/autumn.service";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const browserCreateRequestSchema = z.object({
  ttl: z.number().min(30).max(3600).default(600),
  activityTtl: z.number().min(10).max(3600).default(300),
  streamWebView: z.boolean().default(true),
  integration: integrationSchema.optional().transform(val => val || null),
  profile: z
    .object({
      name: z.string().min(1).max(128),
      saveChanges: z.boolean().default(true),
    })
    .optional(),
});

const browserExecuteRequestSchema = z
  .object({
    code: z.string().min(1).max(100_000).optional(),
    prompt: z.string().min(1).max(10_000).optional(),
    language: z.enum(["python", "node", "bash"]).default("node"),
    timeout: z.number().min(1).max(300).default(30),
    origin: z.string().optional(),
    integration: integrationSchema.optional().transform(val => val || null),
    existingSessionId: z.string().optional(),
  })
  .refine(data => data.code || data.prompt, {
    message: "Either 'code' or 'prompt' must be provided.",
  });

type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

interface BrowserExecuteResponse {
  success: boolean;
  liveViewUrl?: string;
  interactiveLiveViewUrl?: string;
  output?: string;
  stdout?: string;
  result?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
  error?: string;
}

interface BrowserDeleteResponse {
  success: boolean;
  sessionDurationMs?: number;
  creditsBilled?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// POST /v2/scrape/:jobId/interact
// ---------------------------------------------------------------------------

export async function scrapeInteractController(
  req: RequestWithAuth<
    { jobId: string },
    BrowserExecuteResponse,
    BrowserExecuteRequest
  >,
  res: Response<BrowserExecuteResponse>,
) {
  req.body = browserExecuteRequestSchema.parse(req.body);

  const scrapeId = req.params.jobId;
  const { code: rawCode, prompt, language, timeout, origin } = req.body;

  let logger = _logger.child({
    scrapeId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "scrapeInteractController",
  });

  // --- Validate scrape ownership ---

  const scrape = (await supabaseGetScrapeById(
    scrapeId,
  )) as ScrapeContextRow | null;
  if (!scrape) {
    return res.status(404).json({ success: false, error: "Job not found." });
  }
  if (scrape.team_id !== req.auth.team_id) {
    return res.status(403).json({ success: false, error: "Forbidden." });
  }

  // --- Build replay context from original scrape ---

  const replay = buildReplayContextFromScrape(scrape);
  if (!replay.context) {
    return res.status(409).json({
      success: false,
      error:
        replay.error ??
        "Replay context is unavailable for this scrape job. Please rerun the scrape.",
    });
  }
  const replayContext = replay.context;

  logger = logger.child({
    replayTargetUrl: replayContext.targetUrl,
    replayWaitForMs: replayContext.waitForMs,
    replayActions: replayContext.actions.length,
  });

  // --- Ensure a browser session exists (create + replay if needed) ---

  let session = await getBrowserSessionFromScrape(scrapeId);

  if (!session && req.body.existingSessionId) {
    const existing = await getBrowserSession(req.body.existingSessionId);
    if (
      existing &&
      existing.team_id === req.auth.team_id &&
      existing.status === "active"
    ) {
      await updateBrowserSessionScrapeId(existing.id, scrapeId);
      session = { ...existing, scrape_id: scrapeId };
      logger.info("Adopted pre-created browser session for scrape", {
        scrapeId,
        sessionId: session.id,
        browserId: session.browser_id,
      });
    }
  }

  if (!session) {
    const created = await createSessionForScrape(
      req,
      scrapeId,
      replayContext,
      logger,
      (scrape.options as ScrapeOptions).profile,
    );
    if ("error" in created) {
      return res.status(created.status).json(created.body);
    }
    session = created.session;

    logger = logger.child({
      sessionId: session.id,
      browserId: session.browser_id,
    });
    logger.info("Browser session created for scrape", {
      scrapeId,
      sessionId: session.id,
      browserId: session.browser_id,
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({ success: false, error: "Forbidden." });
  }
  if (session.status === "destroyed") {
    return res
      .status(410)
      .json({ success: false, error: "Browser session has been destroyed." });
  }

  updateBrowserSessionActivity(session.id).catch(() => {});

  // --- Execute: prompt-based agent loop OR direct code ---

  let execResult: BrowserServiceExecResponse | AgentResult;

  if (prompt && !rawCode) {
    logger.info("Starting agent loop from prompt", { prompt, timeout });

    markBrowserSessionUsedPrompt(session.id).catch(() => {});

    try {
      execResult = await executePromptViaBrowserAgent(
        prompt,
        session.browser_id,
        timeout,
        logger,
      );
    } catch (err) {
      logger.error("Agent loop failed", { error: err });
      return res.status(502).json({
        success: false,
        error: "Browser agent failed to execute the task.",
      });
    }

    enqueueBrowserSessionActivity({
      team_id: req.auth.team_id,
      session_id: session.id,
      source: "interact",
      language: "bash",
      timeout,
      exit_code: execResult.exitCode ?? null,
      killed: execResult.killed ?? false,
    });
  } else {
    logger.info("Executing code in browser session", { language, timeout });

    try {
      execResult = await browserServiceRequest<BrowserServiceExecResponse>(
        "POST",
        `/browsers/${session.browser_id}/exec`,
        { code: rawCode!, language, timeout, origin },
      );
    } catch (err) {
      logger.error("Failed to execute code via browser service", {
        error: err,
      });
      return res.status(502).json({
        success: false,
        error: "Failed to execute code in browser session.",
      });
    }

    enqueueBrowserSessionActivity({
      team_id: req.auth.team_id,
      session_id: session.id,
      source: "interact",
      language,
      timeout,
      exit_code: execResult.exitCode ?? null,
      killed: execResult.killed ?? false,
    });
  }

  // --- Respond ---

  logger.debug("Execution result", {
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    stdoutLength: execResult.stdout?.length,
    stderrLength: execResult.stderr?.length,
  });

  const hasError = execResult.exitCode !== 0 || execResult.killed;
  const agentOutput = "output" in execResult ? execResult.output : undefined;

  return res.status(200).json({
    success: !hasError,
    liveViewUrl: session.cdp_path,
    interactiveLiveViewUrl: session.cdp_interactive_path,
    ...(agentOutput ? { output: agentOutput } : {}),
    stdout: execResult.stdout,
    result: execResult.result,
    stderr: execResult.stderr,
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    ...(hasError ? { error: execResult.stderr || "Execution failed" } : {}),
  });
}

// ---------------------------------------------------------------------------
// DELETE /v2/scrape/:jobId/interact
// ---------------------------------------------------------------------------

export async function scrapeStopInteractiveBrowserController(
  req: RequestWithAuth<{ jobId: string }, BrowserDeleteResponse>,
  res: Response<BrowserDeleteResponse>,
) {
  let logger = _logger.child({
    scrapeId: req.params.jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "scrapeStopInteractiveBrowserController",
  });

  const session = await getBrowserSessionFromScrape(req.params.jobId);

  if (!session) {
    return res
      .status(404)
      .json({ success: false, error: "Browser session not found." });
  }
  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({ success: false, error: "Forbidden." });
  }

  logger = logger.child({
    sessionId: session.id,
    browserId: session.browser_id,
  });
  logger.info("Deleting browser session");

  let sessionDurationMs: number | undefined;
  try {
    const deleteResult =
      await browserServiceRequest<BrowserServiceDeleteResponse>(
        "DELETE",
        `/browsers/${session.browser_id}`,
      );
    sessionDurationMs = deleteResult?.sessionDurationMs;
  } catch (err) {
    logger.warn("Failed to delete browser session via browser service", {
      error: err,
    });
  }

  const claimed = await claimBrowserSessionDestroyed(session.id);

  invalidateActiveBrowserSessionCount(session.team_id).catch(() => {});
  removeConcurrencyLimitActiveJob(session.team_id, session.id).catch(error => {
    logger.error(
      "Failed to remove concurrency limiter entry for browser session",
      {
        error,
        sessionId: session.id,
        teamId: session.team_id,
      },
    );
  });

  if (!claimed) {
    logger.info("Session already destroyed by another path, skipping billing", {
      sessionId: session.id,
    });
    return res.status(200).json({ success: true });
  }

  const wallClockMs = Date.now() - new Date(session.created_at).getTime();
  const durationMs =
    sessionDurationMs && sessionDurationMs > 0
      ? sessionDurationMs
      : wallClockMs;

  const usedPrompt = await didBrowserSessionUsePrompt(session.id);
  const rate = usedPrompt
    ? INTERACT_CREDITS_PER_HOUR
    : BROWSER_CREDITS_PER_HOUR;
  const creditsBilled = calculateBrowserSessionCredits(durationMs, rate);

  clearBrowserSessionPromptFlag(session.id).catch(() => {});

  updateBrowserSessionCreditsUsed(session.id, creditsBilled).catch(error => {
    logger.error("Failed to update credits_used on browser session", {
      error,
      sessionId: session.id,
      creditsBilled,
    });
  });

  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id ?? undefined,
    creditsBilled,
    req.acuc?.api_key_id ?? null,
    { endpoint: "interact", jobId: session.id },
  ).catch(error => {
    logger.error("Failed to bill team for interact session", {
      error,
      creditsBilled,
      durationMs,
    });
  });

  logger.info("Browser session destroyed", {
    sessionDurationMs: durationMs,
    creditsBilled,
    usedPrompt,
    rate,
  });

  return res.status(200).json({
    success: true,
    sessionDurationMs: durationMs,
    creditsBilled,
  });
}

// ---------------------------------------------------------------------------
// Internal: create a browser session for a scrape, replay original context
// ---------------------------------------------------------------------------

async function createSessionForScrape(
  req: RequestWithAuth<any, any, any>,
  scrapeId: string,
  replayContext: ReturnType<typeof buildReplayContextFromScrape> extends {
    context?: infer C;
  }
    ? NonNullable<C>
    : never,
  logger: typeof _logger,
  profile: { name: string; saveChanges: boolean } | undefined,
): Promise<
  | { session: Awaited<ReturnType<typeof insertBrowserSession>> }
  | { status: number; body: { success: false; error: string }; error: true }
> {
  const sessionId = uuidv7();
  const { ttl, activityTtl, streamWebView } = browserCreateRequestSchema.parse(
    {},
  );
  const integration = req.body?.integration ?? null;

  if (!config.BROWSER_SERVICE_URL) {
    return {
      status: 503,
      body: {
        success: false,
        error:
          "Browser feature is not configured (BROWSER_SERVICE_URL is missing).",
      },
      error: true,
    };
  }

  logger.info("No browser session found for scrape. Creating one.", {
    scrapeId,
    ttl,
    activityTtl,
  });

  // Credit check (uses base rate — actual billing may be higher if prompts are used)
  const estimatedCredits = calculateBrowserSessionCredits(ttl * 1000);
  const autumnAllowed = await autumnService.checkCredits({
    teamId: req.auth.team_id,
    value: estimatedCredits,
    properties: { source: "scrapeBrowserCreate", path: req.path },
  });

  if (autumnAllowed === false) {
    return {
      status: 402,
      body: {
        success: false,
        error: `Insufficient credits for a ${ttl}s browser session (requires ~${estimatedCredits} credits). For more credits, you can upgrade your plan at https://firecrawl.dev/pricing.`,
      },
      error: true,
    };
  }

  // Active session limit — uses the same concurrency pool as scrape/crawl
  const concurrencyLimit = req.acuc?.concurrency ?? 2;
  const activeCount = await getConcurrencyLimitActiveJobsCount(
    req.auth.team_id,
  );
  if (activeCount >= concurrencyLimit) {
    return {
      status: 429,
      body: {
        success: false,
        error: `You have reached the maximum number of concurrent jobs (${concurrencyLimit}). Please wait for existing jobs to complete or destroy browser sessions before creating new ones.`,
      },
      error: true,
    };
  }

  // Create the browser session (retry up to 3 times)
  const MAX_CREATE_RETRIES = 3;
  let svcResponse: BrowserServiceCreateResponse | undefined;
  let lastCreateError: unknown;

  let persistentStorage: { uniqueId: string; write: boolean } | undefined;
  if (profile) {
    const teamHash = createHash("sha256")
      .update(req.auth.team_id)
      .digest("hex")
      .slice(0, 16);
    persistentStorage = {
      uniqueId: `${teamHash}_${profile.name}`,
      write: profile.saveChanges !== false,
    };
  }

  for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
    try {
      svcResponse = await browserServiceRequest<BrowserServiceCreateResponse>(
        "POST",
        "/browsers",
        {
          ttl,
          ...(activityTtl !== undefined ? { activityTtl } : {}),
          ...(persistentStorage !== undefined ? { persistentStorage } : {}),
        },
      );
      break;
    } catch (err) {
      if (err instanceof BrowserServiceError && err.status === 409) {
        return {
          status: 409,
          body: {
            success: false,
            error:
              "Another session is currently writing to this profile. Only one writer is allowed at a time. You can still access it with saveChanges: false, or try again later.",
          },
          error: true,
        };
      }
      lastCreateError = err;
      logger.warn("Browser session creation attempt failed", {
        attempt,
        maxRetries: MAX_CREATE_RETRIES,
        error: err,
      });
      if (attempt < MAX_CREATE_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  if (!svcResponse) {
    logger.error("Failed to create browser session after all retries", {
      error: lastCreateError,
    });
    return {
      status: 502,
      body: { success: false, error: "Failed to create browser session." },
      error: true,
    };
  }

  // Replay original scrape context
  try {
    const replayResult =
      await browserServiceRequest<BrowserServiceExecResponse>(
        "POST",
        `/browsers/${svcResponse.sessionId}/exec`,
        {
          code: buildReplayScript(replayContext),
          language: "node",
          timeout: estimateReplayTimeoutSeconds(replayContext),
          origin: "scrape_replay",
        },
      );

    if (replayResult.exitCode !== 0 || replayResult.killed) {
      throw new Error(
        replayResult.stderr?.trim() ||
          replayResult.stdout?.trim() ||
          "Replay script exited with an error.",
      );
    }

    // Ensure only one tab exists with the content page in the foreground.
    // The replay may have created extra tabs. Find the one with content,
    // close everything else, update the REPL's page var, and bring to front.
    await browserServiceRequest(
      "POST",
      `/browsers/${svcResponse.sessionId}/exec`,
      {
        code: [
          `const ctx = page.context();`,
          `const pages = ctx.pages();`,
          `if (pages.length > 1) {`,
          `  const target = pages.find(p => { const u = p.url(); return u && u !== 'about:blank'; }) || pages[pages.length - 1];`,
          `  for (const p of pages) { if (p !== target) await p.close().catch(() => {}); }`,
          `  page = target;`,
          `}`,
          `await page.bringToFront();`,
        ].join("\n"),
        language: "node",
        timeout: 10,
        origin: "tab_sync",
      },
    ).catch(() => {});

    // Sync agent-browser to the correct page
    const syncResult = await browserServiceRequest<BrowserServiceExecResponse>(
      "POST",
      `/browsers/${svcResponse.sessionId}/exec`,
      {
        code: `agent-browser get url`,
        language: "bash",
        timeout: 10,
        origin: "scrape_replay_sync",
      },
    );

    const agentUrl = (syncResult.stdout || "").trim();
    if (!agentUrl || agentUrl === "about:blank") {
      logger.info("agent-browser on wrong page after replay, navigating", {
        agentUrl,
        targetUrl: replayContext.targetUrl,
      });
      await browserServiceRequest<BrowserServiceExecResponse>(
        "POST",
        `/browsers/${svcResponse.sessionId}/exec`,
        {
          code: `await page.goto(${JSON.stringify(replayContext.targetUrl)}, { waitUntil: "networkidle0" });`,
          language: "node",
          timeout: 30,
          origin: "scrape_replay_sync",
        },
      );
    }
  } catch (err) {
    logger.error("Failed to initialize scrape browser session context", {
      error: err,
    });
    await browserServiceRequest(
      "DELETE",
      `/browsers/${svcResponse.sessionId}`,
    ).catch(() => {});
    return {
      status: 409,
      body: {
        success: false,
        error:
          "Failed to initialize browser session from the original scrape context. Please rerun the scrape and try again.",
      },
      error: true,
    };
  }

  // Persist in Supabase
  try {
    await logRequest({
      id: sessionId,
      kind: "interact",
      api_version: "v2",
      team_id: req.auth.team_id,
      target_hint: "Interact session",
      origin: req.body?.origin ?? "api",
      integration: integration ?? null,
      zeroDataRetention: false,
      api_key_id: req.acuc?.api_key_id ?? null,
    });
    const session = await insertBrowserSession({
      id: sessionId,
      team_id: req.auth.team_id,
      scrape_id: scrapeId,
      browser_id: svcResponse.sessionId,
      workspace_id: "",
      context_id: "",
      cdp_url: svcResponse.cdpUrl,
      cdp_path: svcResponse.iframeUrl,
      cdp_interactive_path: svcResponse.interactiveIframeUrl,
      stream_web_view: streamWebView,
      status: "active",
      ttl_total: ttl,
      ttl_without_activity: activityTtl ?? null,
      credits_used: null,
    });

    invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});

    // Register in the shared concurrency limiter so this session counts
    // against the team's concurrent job limit while it's active.
    pushConcurrencyLimitActiveJob(
      req.auth.team_id,
      sessionId,
      ttl * 1000,
    ).catch(() => {});

    return { session };
  } catch (err) {
    logger.error("Failed to persist browser session, cleaning up", {
      error: err,
    });
    await browserServiceRequest(
      "DELETE",
      `/browsers/${svcResponse.sessionId}`,
    ).catch(() => {});
    return {
      status: 500,
      body: { success: false, error: "Failed to persist browser session." },
      error: true,
    };
  }
}
