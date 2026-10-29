import { Request, Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { RequestWithAuth } from "./types";
import {
  createAuthorizeUrl,
  handleOAuthCallback,
  isSlackConfigured,
} from "../../services/integrations/slack/oauth";
import {
  deleteSlackInstallationByTeam,
  deleteSlackInstallationsBySlackTeam,
  getSlackInstallationByTeam,
  getSlackInstallationBySlackTeam,
} from "../../services/integrations/slack/store";
import { decryptSlackToken } from "../../services/integrations/slack/crypto";
import {
  listChannels,
  postToResponseUrl,
} from "../../services/integrations/slack/client";
import { verifySlackSignature } from "../../services/integrations/slack/signature";
import {
  handleFirecrawlCommand,
  handleSlashCommand,
} from "../../services/integrations/slack/commands";
import type { SlackConnectionStatus } from "../../services/integrations/slack/types";

const logger = _logger.child({ module: "slack-controller" });

const startBodySchema = z.object({
  redirectPath: z.string().max(512).optional(),
  // When present, the install is tied to this monitor so we can auto-enable
  // Slack notifications on it once the user picks a channel during install.
  monitorId: z.string().uuid().optional(),
});

// Builds an absolute dashboard URL for post-OAuth browser redirects.
function dashboardRedirect(path: string, params: Record<string, string>): string {
  const url = new URL(path, config.FIRECRAWL_DASHBOARD_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// POST /v2/slack/oauth/start (auth) — returns the Slack authorize URL for the
// caller's team. The dashboard redirects the browser to it.
export async function slackOAuthStartController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
) {
  if (!isSlackConfigured()) {
    return res
      .status(503)
      .json({ success: false, error: "Slack integration is not configured" });
  }

  const body = startBodySchema.safeParse(req.body ?? {});
  const redirectPath = body.success ? body.data.redirectPath : undefined;
  const monitorId = body.success ? body.data.monitorId : undefined;

  try {
    const { url } = await createAuthorizeUrl({
      teamId: req.auth.team_id,
      redirectPath,
      monitorId,
    });
    return res.status(200).json({ success: true, url });
  } catch (error) {
    logger.error("Failed to build Slack authorize URL", { error });
    return res
      .status(500)
      .json({ success: false, error: "Failed to start Slack connection" });
  }
}

// GET /v2/slack/oauth/callback (public) — Slack redirects here after the user
// approves. We exchange the code and bounce the browser back to the dashboard.
export async function slackOAuthCallbackController(req: Request, res: Response) {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const slackError =
    typeof req.query.error === "string" ? req.query.error : undefined;

  if (slackError) {
    return res.redirect(
      dashboardRedirect("/app/monitoring", { slack: "error", reason: slackError }),
    );
  }

  if (!code || !state) {
    return res.redirect(
      dashboardRedirect("/app/monitoring", {
        slack: "error",
        reason: "missing_params",
      }),
    );
  }

  // This handler lands in the user's browser, so it must never surface a 500 via
  // wrap() — any failure (Redis in consumeState, network in the token exchange,
  // etc.) should bounce them back to the dashboard with an error.
  try {
    const result = await handleOAuthCallback({ code, state });
    if (!result.ok) {
      return res.redirect(
        dashboardRedirect(result.redirectPath, {
          slack: "error",
          reason: result.error,
        }),
      );
    }

    return res.redirect(
      dashboardRedirect(result.redirectPath, { slack: "connected" }),
    );
  } catch (error) {
    // redirectPath from the OAuth state isn't recoverable here, so fall back to
    // the monitoring root.
    logger.error("Slack OAuth callback failed", { error });
    return res.redirect(
      dashboardRedirect("/app/monitoring", {
        slack: "error",
        reason: "callback_failed",
      }),
    );
  }
}

// GET /v2/slack/status (auth) — connection status for the team.
export async function slackStatusController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
) {
  const installation = await getSlackInstallationByTeam(req.auth.team_id);
  const status: SlackConnectionStatus = installation
    ? {
        connected: true,
        slackTeamId: installation.slack_team_id,
        slackTeamName: installation.slack_team_name,
        botUserId: installation.bot_user_id,
        scope: installation.scope,
        authedUserId: installation.authed_user_id,
        installedAt: installation.created_at,
        defaultChannelId: installation.incoming_webhook?.channel_id ?? null,
        defaultChannelName: installation.incoming_webhook?.channel
          ? installation.incoming_webhook.channel.replace(/^#/, "")
          : null,
      }
    : { connected: false };

  return res.status(200).json({
    success: true,
    configured: isSlackConfigured(),
    data: status,
  });
}

// GET /v2/slack/channels (auth) — channels the bot can post to.
export async function slackChannelsController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
) {
  const installation = await getSlackInstallationByTeam(req.auth.team_id);
  if (!installation) {
    return res
      .status(404)
      .json({ success: false, error: "Slack is not connected" });
  }

  let token: string;
  try {
    token = decryptSlackToken(installation.bot_token);
  } catch (error) {
    logger.error("Failed to decrypt Slack token for channel list", { error });
    return res
      .status(500)
      .json({ success: false, error: "Slack token unavailable" });
  }

  const result = await listChannels({ token });
  if (!result.ok) {
    return res.status(502).json({
      success: false,
      error: result.error ?? "Failed to list Slack channels",
    });
  }

  return res.status(200).json({ success: true, data: result.channels });
}

// DELETE /v2/slack/installation (auth) — disconnect the workspace.
export async function slackDisconnectController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
) {
  await deleteSlackInstallationByTeam(req.auth.team_id);
  return res.status(200).json({ success: true });
}

// POST /v2/slack/commands (public, signature-verified) — the /monitor and
// /firecrawl slash commands. Slack enforces a 3-second ack deadline, so we
// respond immediately and deliver results via response_url.
export async function slackCommandsController(req: Request, res: Response) {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const valid = verifySlackSignature({
    signature: req.headers["x-slack-signature"] as string | undefined,
    timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
    rawBody: rawBody ?? "",
  });
  if (!valid) {
    return res.status(401).send("invalid signature");
  }

  const body = (req.body ?? {}) as Record<string, string>;

  // Slack pings this endpoint with ssl_check when you save the URL.
  if (body.ssl_check === "1") {
    return res.status(200).send("");
  }

  const slackTeamId = body.team_id;
  if (!slackTeamId) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Missing workspace context.",
    });
  }

  const runCommand = async (): Promise<{
    response_type: "ephemeral" | "in_channel";
    text: string;
    blocks?: unknown[];
  }> => {
    const installation = await getSlackInstallationBySlackTeam(slackTeamId);
    if (!installation) {
      return {
        response_type: "ephemeral",
        text: `This workspace isn't linked to Firecrawl yet. Connect it from the dashboard: ${config.FIRECRAWL_DASHBOARD_URL}/app/monitoring`,
      };
    }

    // Both /monitor and /firecrawl post to this endpoint; route by which
    // command Slack sent so account/workspace commands stay off /monitor.
    const command = (body.command ?? "").toLowerCase();
    const handler =
      command === "/firecrawl" ? handleFirecrawlCommand : handleSlashCommand;
    return handler({
      installation,
      text: body.text ?? "",
      channelId: body.channel_id ?? "",
      channelName: body.channel_name ?? "this channel",
      userId: body.user_id ?? "",
    });
  };

  const responseUrl = body.response_url;
  if (!responseUrl) {
    // Shouldn't happen for real slash commands; handle inline as a fallback.
    try {
      return res.status(200).json(await runCommand());
    } catch (error) {
      logger.error("Slack slash command failed", { error, slackTeamId });
      return res.status(200).json({
        response_type: "ephemeral",
        text: "Something went wrong handling that command.",
      });
    }
  }

  // Ack immediately — Slack shows "operation_timeout" if we take >3s (DB and
  // billing lookups can exceed that). The real result is delivered via the
  // response_url, which stays valid for ~30 minutes.
  res.status(200).send("");

  void (async () => {
    try {
      const response = await runCommand();
      await postToResponseUrl(responseUrl, response);
    } catch (error) {
      logger.error("Slack slash command failed", { error, slackTeamId });
      await postToResponseUrl(responseUrl, {
        response_type: "ephemeral",
        text: "Something went wrong handling that command.",
      }).catch(() => {});
    }
  })();
}

// POST /v2/slack/events (public, signature-verified) — URL verification during
// setup + lifecycle events (uninstall / token revocation) for cleanup.
export async function slackEventsController(req: Request, res: Response) {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const body = (req.body ?? {}) as Record<string, any>;

  // URL verification challenge is also signed; verify before responding.
  const valid = verifySlackSignature({
    signature: req.headers["x-slack-signature"] as string | undefined,
    timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
    rawBody: rawBody ?? "",
  });
  if (!valid) {
    return res.status(401).send("invalid signature");
  }

  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body.type === "event_callback" && body.event?.type) {
    const event = body.event as {
      type?: string;
      tokens?: { bot?: unknown[]; oauth?: unknown[] };
    };
    const eventType = event.type;
    const slackTeamId = (body.team_id as string) || undefined;

    // Only tear down the installation on a full uninstall, or when the BOT
    // token itself is revoked. `tokens_revoked` also fires for user-token-only
    // revocations (`event.tokens.oauth`), which leave the bot token — the one
    // the integration actually uses — valid, so those must be ignored.
    const botTokenRevoked =
      eventType === "tokens_revoked" &&
      Array.isArray(event.tokens?.bot) &&
      event.tokens.bot.length > 0;
    const shouldDisconnect =
      eventType === "app_uninstalled" || botTokenRevoked;

    if (shouldDisconnect && slackTeamId) {
      try {
        await deleteSlackInstallationsBySlackTeam(slackTeamId);
        logger.info("Removed Slack installation after lifecycle event", {
          eventType,
          slackTeamId,
        });
      } catch (error) {
        logger.warn("Failed to clean up Slack installation", {
          error,
          slackTeamId,
        });
      }
    }
  }

  return res.status(200).send("");
}
