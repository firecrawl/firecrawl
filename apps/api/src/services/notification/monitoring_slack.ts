import { logger as _logger } from "../../lib/logger";
import type { MonitorCheckRow, MonitorRow } from "../monitoring/types";
import { getSlackInstallationByTeam } from "../integrations/slack/store";
import { decryptSlackToken } from "../integrations/slack/crypto";
import { joinChannel, postSlackMessage } from "../integrations/slack/client";
import {
  buildMonitorAlertMessage,
  type MonitorSlackPage,
} from "../integrations/slack/messages";
import { buildMonitoringCheckDashboardUrl } from "./monitoring_email";

const logger = _logger.child({ module: "monitoring-slack" });

type SlackSummaryPage = {
  url: string;
  status: string;
  judgment?: {
    meaningful: boolean;
    confidence: "high" | "medium" | "low";
    reason: string;
  } | null;
};

type SlackSummaryResult = {
  attempted: boolean;
  success: boolean;
  channel?: string;
  error?: string;
};

// Mirrors the email judge gate: only suppress when the changed-page list is
// complete and every changed page is judged noise (a missed alert is worse than
// a noisy one).
export function shouldSuppressForNoise(
  monitor: MonitorRow,
  check: MonitorCheckRow,
  pages: SlackSummaryPage[],
): boolean {
  if (!monitor.judge_enabled || !monitor.goal) return false;
  const changedPages = pages.filter(p => p.status === "changed");
  // Use the authoritative check counters (aggregated over ALL pages), not the
  // page list — the runner caps `pages` at 100, so scanning it can miss
  // new/removed/error activity beyond the cap and wrongly suppress a real alert.
  const nonChangedActivity =
    check.new_count > 0 || check.removed_count > 0 || check.error_count > 0;
  const changedListComplete = changedPages.length >= check.changed_count;
  if (changedPages.length > 0 && !nonChangedActivity && changedListComplete) {
    const anyMeaningful = changedPages.some(
      p => p.judgment?.meaningful === true || !p.judgment,
    );
    return !anyMeaningful;
  }
  return false;
}

export async function sendMonitoringSlackSummary(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  pages: SlackSummaryPage[];
}): Promise<SlackSummaryResult> {
  const slackConfig = params.monitor.notification?.slack;
  if (!slackConfig?.enabled) {
    return { attempted: false, success: true };
  }

  const channelId = slackConfig.channelId;
  if (!channelId) {
    logger.warn("Slack notifications enabled but no channel configured", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
    });
    return { attempted: false, success: false, error: "no_channel" };
  }

  const activity =
    params.check.changed_count +
    params.check.new_count +
    params.check.removed_count +
    params.check.error_count;
  if (activity <= 0) {
    return { attempted: false, success: true, channel: channelId };
  }

  if (shouldSuppressForNoise(params.monitor, params.check, params.pages)) {
    logger.info("Skipping Slack summary; all changed pages judged noise", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
    });
    return { attempted: false, success: true, channel: channelId };
  }

  const installation = await getSlackInstallationByTeam(params.monitor.team_id);
  if (!installation) {
    logger.warn("Slack notifications enabled but workspace not connected", {
      monitorId: params.monitor.id,
      teamId: params.monitor.team_id,
    });
    return { attempted: false, success: false, error: "not_connected" };
  }

  let token: string;
  try {
    token = decryptSlackToken(installation.bot_token);
  } catch (error) {
    logger.error("Failed to decrypt Slack bot token", {
      error,
      teamId: params.monitor.team_id,
    });
    return { attempted: false, success: false, error: "token_decrypt_failed" };
  }

  const dashboardUrl = buildMonitoringCheckDashboardUrl({
    monitorId: params.monitor.id,
    checkId: params.check.id,
  });

  const slackPages: MonitorSlackPage[] = params.pages.map(page => ({
    url: page.url,
    status: page.status,
    judgment: page.judgment
      ? { meaningful: page.judgment.meaningful, reason: page.judgment.reason }
      : null,
  }));

  const { text, blocks } = buildMonitorAlertMessage({
    monitorName: params.monitor.name,
    dashboardUrl,
    checkId: params.check.id,
    summary: {
      changed: params.check.changed_count,
      new: params.check.new_count,
      removed: params.check.removed_count,
      error: params.check.error_count,
      totalPages: params.check.total_pages,
    },
    pages: slackPages,
    creditsUsed: params.check.actual_credits,
  });

  let res = await postSlackMessage({ token, channel: channelId, text, blocks });

  // Public channels: auto-join once and retry so the first alert lands even if
  // nobody invited the bot. Private channels still require a manual /invite.
  if (!res.ok && res.error === "not_in_channel") {
    const joined = await joinChannel({ token, channel: channelId });
    if (joined.ok) {
      res = await postSlackMessage({ token, channel: channelId, text, blocks });
    }
  }

  if (!res.ok) {
    logger.warn("Slack monitor summary failed", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
      channel: channelId,
      error: res.error,
    });
    return {
      attempted: true,
      success: false,
      channel: channelId,
      error: res.error,
    };
  }

  logger.info("Slack monitor summary sent", {
    monitorId: params.monitor.id,
    checkId: params.check.id,
    channel: channelId,
  });
  return { attempted: true, success: true, channel: channelId };
}
