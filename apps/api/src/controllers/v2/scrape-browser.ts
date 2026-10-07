import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  getBrowserSession,
  getBrowserSessionFromScrape,
  updateBrowserSessionActivity,
  updateBrowserSessionScrapeId,
} from "../../lib/browser-sessions";
import {
  BrowserExecutionResult,
  executeHangarBrowser,
  HangarError,
} from "../../lib/hangar";
import {
  createBrowserSession,
  getBrowserZDR,
  BrowserSessionError,
  reserveBrowserPromptCredits,
  stopBrowserSession,
  browserSessionLinks,
  invalidAgentInteropError,
} from "../../lib/browser-lifecycle";
import { browserCreateRequestSchema, browserError } from "./browser";
import {
  buildReplayContextFromScrape,
  estimateReplayTimeoutSeconds,
  buildReplayScript,
} from "../../lib/scrape-interact/scrape-replay";
import {
  executePromptViaBrowserAgent,
  executeCodeViaBrowserSession,
  selectBrowserAgentTab,
  AgentResult,
} from "../../lib/scrape-interact/browser-agent";
import { sanitizeUrlForTrace } from "../../lib/scrape-interact/langsmith";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { withZeroDataRetention } from "../../lib/otel-tracer";
import {
  getSafeMode,
  SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE,
} from "../../lib/safe-mode";
import { RequestWithAuth, ScrapeOptions } from "./types";
import {
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  keylessTeamUuid,
  keylessLimitBody,
} from "../../lib/keyless";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
import { integrationSchema } from "../../utils/integration";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
import { getScrapeJobAccess } from "../../lib/operational-job-access";
import { readScrapeJobState } from "../../lib/job-state-store";
import {
  type BrowserOptions,
  browserOptionsFromScrape,
} from "../../lib/browser-options";
import { scrapeQueue } from "../../services/worker/nuq-router";

const browserExecuteRequestSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .refine(
        value => Buffer.byteLength(value, "utf8") <= 100_000,
        "Code must not exceed 100,000 UTF-8 bytes.",
      )
      .optional(),
    prompt: z.string().min(1).max(10_000).optional(),
    language: z.enum(["python", "node", "bash"]).default("node"),
    timeout: z.number().min(1).max(300).default(30),
    origin: z.string().optional(),
    integration: integrationSchema.optional().transform(val => val || null),
    existingSessionId: z.string().optional(),
    zeroDataRetention: z.boolean().optional(),
    // ZDR scrapes do not retain the URL needed to initialize a new browser.
    url: z.url().optional(),
  })
  .refine(data => data.code || data.prompt, {
    message: "Either 'code' or 'prompt' must be provided.",
  });

type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

interface BrowserExecuteResponse {
  success: boolean;
  sessionId?: string;
  truncated?: boolean;
  cdpUrl?: string;
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

export async function scrapeInteractController(
  req: RequestWithAuth<
    { jobId: string },
    BrowserExecuteResponse,
    BrowserExecuteRequest
  >,
  res: Response<BrowserExecuteResponse>,
) {
  try {
    return await withZeroDataRetention(
      getScrapeZDR(req.acuc?.flags) === "forced" ||
        req.body?.zeroDataRetention === true,
      () => scrapeInteractInternal(req, res),
    );
  } catch (error) {
    if (
      !(error instanceof BrowserSessionError) &&
      !(error instanceof HangarError)
    )
      throw error;
    return browserError(res, error, req);
  }
}

async function scrapeInteractInternal(
  req: RequestWithAuth<
    { jobId: string },
    BrowserExecuteResponse,
    BrowserExecuteRequest
  >,
  res: Response<BrowserExecuteResponse>,
) {
  // Before the reuse-or-create branch, so a reused session is guarded too.
  const invalidInterop = invalidAgentInteropError(req);
  if (invalidInterop) {
    return res
      .status(invalidInterop.status)
      .json({ success: false, error: invalidInterop.message });
  }

  req.body = browserExecuteRequestSchema.parse(req.body);

  if (getSafeMode(req.acuc?.flags)) {
    return res.status(403).json({
      success: false,
      error: SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE,
    });
  }

  const scrapeId = req.params.jobId;
  const { code: rawCode, prompt, language, timeout, origin } = req.body;
  let zeroDataRetention = getBrowserZDR(req);

  let logger = _logger.child({
    scrapeId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "scrapeInteractController",
    zeroDataRetention,
  });

  // --- Validate scrape ownership ---

  if (config.USE_DB_AUTHENTICATION !== true) {
    return res.status(501).json({
      success: false,
      error:
        "Scrape interact requires stored scrape context and is not available when database authentication is disabled.",
    });
  }

  // Suppress lookup telemetry until the stored retention policy is known.
  const [nuqJob, state, storedSession] = await withZeroDataRetention(true, () =>
    Promise.all([
      scrapeQueue.getJob(scrapeId, logger.child({ zeroDataRetention: true })),
      // A failed policy read must not turn a ZDR scrape into a retained session.
      readScrapeJobState(scrapeId),
      getBrowserSessionFromScrape(scrapeId),
    ]),
  );
  const access = nuqJob
    ? null
    : await withZeroDataRetention(true, () => getScrapeJobAccess(scrapeId));
  if (
    (!nuqJob && (!access || access.expiresAtMs <= Date.now())) ||
    (nuqJob && nuqJob.data.mode !== "single_urls")
  ) {
    return res.status(404).json({ success: false, error: "Job not found." });
  }
  // Keyless scrapes are persisted under a deterministic per-IP UUID (the
  // `scrapes.team_id` column is a UUID, so the raw `preview_keyless_<ip>` string
  // can't be stored). Compare against that derived UUID for keyless requests.
  const expectedScrapeTeam =
    keylessTeamUuid(req.auth.team_id) ?? req.auth.team_id;
  if (
    (access && access.teamId !== expectedScrapeTeam) ||
    (nuqJob && nuqJob.data.team_id !== req.auth.team_id)
  ) {
    return res.status(403).json({ success: false, error: "Forbidden." });
  }

  // --- Build replay context from original scrape ---

  zeroDataRetention ||=
    state?.zeroDataRetention === true ||
    nuqJob?.data.zeroDataRetention === true ||
    storedSession?.zero_data_retention === true;
  logger = logger.child({ zeroDataRetention });

  let replayContext = state?.replay;
  let replayError: string | undefined;
  if (!replayContext && nuqJob?.data.mode === "single_urls") {
    const replay = buildReplayContextFromScrape({
      id: scrapeId,
      team_id: nuqJob.data.team_id,
      url: nuqJob.data.url,
      options: nuqJob.data.scrapeOptions,
    });
    replayContext = replay.context;
    replayError = replay.error;
  }
  if (!replayContext && req.body.url) {
    replayContext = { targetUrl: req.body.url, waitForMs: 0, actions: [] };
  }

  // --- Ensure a browser session exists (create + replay if needed) ---

  let session = storedSession;

  if (!session && req.body.existingSessionId) {
    const existing = await withZeroDataRetention(true, () =>
      getBrowserSession(req.body.existingSessionId!),
    );
    if (
      existing &&
      existing.team_id === req.auth.team_id &&
      existing.status === "active"
    ) {
      zeroDataRetention = getBrowserZDR(req, existing, zeroDataRetention);
      logger = logger.child({ zeroDataRetention });
      await withZeroDataRetention(zeroDataRetention, () =>
        updateBrowserSessionScrapeId(existing.id, scrapeId),
      );
      session = { ...existing, scrape_id: scrapeId };
      logger.info("Adopted pre-created browser session for scrape", {
        scrapeId,
        sessionId: session.id,
        browserId: session.browser_id,
      });
    }
  }

  if (!session) {
    if (!replayContext) {
      return res.status(409).json({
        success: false,
        error:
          replayError ??
          "Replay context is unavailable. Supply url or an existingSessionId to continue without retained scrape context.",
      });
    }
    const browserOptions =
      state?.browser ??
      browserOptionsFromScrape(
        nuqJob?.data.mode === "single_urls"
          ? nuqJob.data.scrapeOptions
          : { profile: state?.profile },
      );
    const created = await createSessionForScrape(
      req,
      scrapeId,
      replayContext,
      logger,
      browserOptions,
      zeroDataRetention,
    );
    if (created.error === true) {
      // A keyless limit body carries the caller's own link, so match on it
      // rather than on the message text.
      if (created.status === 429 && "signup_url" in created.body) {
        applyAgentAuthDiscoveryHeader(res);
      }
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

  zeroDataRetention = getBrowserZDR(req, session, zeroDataRetention);
  logger = logger.child({ zeroDataRetention });
  return withZeroDataRetention(zeroDataRetention, async () => {
    updateBrowserSessionActivity(session.id).catch(() => {});
    // --- Execute: prompt-based agent loop OR direct code ---
    //
    // The persisted session policy applies to every execution, including calls
    // that omit the original request's ZDR option.

    // Upstream context from the scrape job. Interact extends scrape, so
    // every run carries the URL / wait / actions / origin that set the stage
    // for what the agent does on top of it. URLs are stripped of query
    // strings to avoid leaking PII into LangSmith.
    const traceScrapeContext = {
      scrapeUrl: sanitizeUrlForTrace(replayContext?.targetUrl),
      targetUrl: sanitizeUrlForTrace(replayContext?.targetUrl),
      scrapeWaitForMs: replayContext?.waitForMs,
      scrapeActions: replayContext?.actions.length,
      scrapeOrigin:
        state?.origin ??
        (nuqJob?.data.mode === "single_urls" ? nuqJob.data.origin : undefined),
    };

    // Identity fields below team_id are optional, normalized from null to undefined.
    // so LangSmith metadata filters don't match empty strings.
    const traceIdentity = {
      orgId: req.auth.org_id ?? undefined,
    };

    let execResult: BrowserExecutionResult | AgentResult;

    if (prompt && !rawCode) {
      logger.info("Starting agent loop from prompt", { prompt, timeout });

      try {
        await reserveBrowserPromptCredits(req, session);
      } catch (error) {
        return browserError(res, error, req);
      }

      try {
        execResult = await executePromptViaBrowserAgent(
          prompt,
          session.browser_id,
          timeout,
          logger,
          {
            sessionId: session.id,
            scrapeId,
            teamId: req.auth.team_id,
            ...traceIdentity,
            zeroDataRetention,
            ...traceScrapeContext,
          },
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
        execResult = await executeCodeViaBrowserSession(
          session.browser_id,
          { code: rawCode!, language, timeout, origin },
          {
            sessionId: session.id,
            scrapeId,
            teamId: req.auth.team_id,
            ...traceIdentity,
            zeroDataRetention,
            ...traceScrapeContext,
          },
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
      truncated: execResult.truncated,
      stdoutLength: execResult.stdout?.length,
      stderrLength: execResult.stderr?.length,
    });

    const hasError = execResult.exitCode !== 0 || execResult.killed;
    const agentOutput = "output" in execResult ? execResult.output : undefined;

    return res.status(200).json({
      success: !hasError,
      sessionId: session.id,
      ...browserSessionLinks(session),
      ...(agentOutput ? { output: agentOutput } : {}),
      stdout: execResult.stdout,
      result: execResult.result,
      stderr: execResult.stderr,
      exitCode: execResult.exitCode,
      killed: execResult.killed,
      truncated: execResult.truncated,
      ...(hasError ? { error: execResult.stderr || "Execution failed" } : {}),
    });
  });
}

export async function scrapeStopInteractiveBrowserController(
  req: RequestWithAuth<{ jobId: string }, BrowserDeleteResponse>,
  res: Response<BrowserDeleteResponse>,
) {
  const session = await getBrowserSessionFromScrape(req.params.jobId);
  if (!session)
    return res
      .status(404)
      .json({ success: false, error: "Browser session not found." });
  if (session.team_id !== req.auth.team_id)
    return res.status(403).json({ success: false, error: "Forbidden." });
  try {
    return res.json(await stopBrowserSession(session));
  } catch (error) {
    return browserError(res, error, req);
  }
}

async function createSessionForScrape(
  req: RequestWithAuth<any, any, any>,
  scrapeId: string,
  replayContext: NonNullable<
    ReturnType<typeof buildReplayContextFromScrape>["context"]
  >,
  logger: typeof _logger,
  browserOptions: BrowserOptions,
  zeroDataRetention: boolean,
) {
  try {
    const { session } = await createBrowserSession(req, {
      ...browserCreateRequestSchema.parse({}),
      ...browserOptions,
      scrapeId,
      zeroDataRetention,
      initialize: async browserId => {
        const replay = await executeHangarBrowser(browserId, {
          code: buildReplayScript(replayContext),
          language: "node",
          timeout: estimateReplayTimeoutSeconds(replayContext),
        });
        if (replay.exitCode !== 0 || replay.killed)
          throw new HangarError(
            409,
            "Failed to initialize browser session from the original scrape context. Please rerun the scrape and try again.",
          );
        await selectBrowserAgentTab(browserId);
      },
    });
    return { session };
  } catch (error) {
    logger.error("Failed to initialize scrape browser session", { error });
    const knownError =
      error instanceof BrowserSessionError || error instanceof HangarError;
    const status = knownError ? error.status : 502;
    const message = knownError
      ? error.message
      : "Failed to create browser session.";
    const body =
      message === KEYLESS_FREE_TIER_LIMIT_MESSAGE
        ? await keylessLimitBody(req.auth.team_id, "v2_browser", req)
        : { success: false as const, error: message };
    return { error: true as const, status, body };
  }
}
