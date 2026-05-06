import { Resend } from "resend";
import escapeHtml from "escape-html";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { supabase_service } from "../supabase";
import type { MonitorCheckRow, MonitorRow } from "../monitoring/types";

const logger = _logger.child({ module: "monitoring-email" });

type MonitoringEmailPage = {
  url: string;
  status: string;
  error?: string | null;
};

type MonitoringEmailPayload = {
  monitorId: string;
  monitorName: string;
  checkId: string;
  summary: {
    changed: number;
    new: number;
    removed: number;
    error: number;
    totalPages: number;
  };
  pages: MonitoringEmailPage[];
  creditsUsed: number | null;
};

async function getTeamEmails(teamId: string): Promise<string[]> {
  const { data, error } = await supabase_service
    .from("user_teams")
    .select(
      "users(email, id, notification_preferences(unsubscribed_all, email_preferences))",
    )
    .eq("team_id", teamId);

  if (error) {
    logger.warn("Failed to load team emails", { error, teamId });
    return [];
  }

  const emails = new Set<string>();
  for (const row of data ?? []) {
    const user = (row as any).users;
    const email = user?.email;
    if (!email) continue;

    const prefs = Array.isArray(user.notification_preferences)
      ? user.notification_preferences[0]
      : user.notification_preferences;
    if (prefs?.unsubscribed_all) continue;
    if (
      Array.isArray(prefs?.email_preferences) &&
      !prefs.email_preferences.includes("system_alerts")
    ) {
      continue;
    }

    emails.add(email);
  }

  return [...emails];
}

function buildHtml(payload: MonitoringEmailPayload): string {
  const pageItems = payload.pages
    .slice(0, 20)
    .map(page => {
      const url = escapeHtml(page.url);
      return `<li><strong>${escapeHtml(page.status)}</strong>: <a href="${url}">${url}</a>${
        page.error ? ` &mdash; ${escapeHtml(page.error)}` : ""
      }</li>`;
    })
    .join("");

  return `Hey there,<br/>
<p>Your Firecrawl monitor <strong>${escapeHtml(payload.monitorName)}</strong> detected activity.</p>
<ul>
  <li>Changed: ${payload.summary.changed}</li>
  <li>New: ${payload.summary.new}</li>
  <li>Removed: ${payload.summary.removed}</li>
  <li>Errors: ${payload.summary.error}</li>
  <li>Total pages checked: ${payload.summary.totalPages}</li>
</ul>
${pageItems ? `<p>Top pages:</p><ul>${pageItems}</ul>` : ""}
<p>Check ID: <code>${escapeHtml(payload.checkId)}</code></p>
<p>Credits used: ${payload.creditsUsed ?? "unknown"}</p>
<br/>Thanks,<br/>Firecrawl Team<br/>`;
}

export async function sendMonitoringEmailSummary(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  pages: MonitoringEmailPage[];
}): Promise<{
  attempted: boolean;
  success: boolean;
  recipients: string[];
  error?: string;
}> {
  const configEmail = params.monitor.notification?.email;
  if (!configEmail?.enabled) {
    logger.info(
      "Skipping monitoring email summary; email notifications disabled",
      {
        monitorId: params.monitor.id,
        checkId: params.check.id,
      },
    );
    return { attempted: false, success: true, recipients: [] };
  }

  if (
    params.check.changed_count +
      params.check.new_count +
      params.check.removed_count +
      params.check.error_count <=
    0
  ) {
    logger.info("Skipping monitoring email summary; no changes detected", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
      changed: params.check.changed_count,
      new: params.check.new_count,
      removed: params.check.removed_count,
      errors: params.check.error_count,
    });
    return { attempted: false, success: true, recipients: [] };
  }

  const explicitRecipients = configEmail.recipients ?? [];
  const teamRecipients =
    explicitRecipients.length > 0
      ? []
      : await getTeamEmails(params.monitor.team_id);
  const recipients = [...new Set([...explicitRecipients, ...teamRecipients])];
  if (recipients.length === 0) {
    logger.info("Skipping monitoring email summary; no recipients configured", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
    });
    return { attempted: false, success: true, recipients };
  }

  const resendApiKey = config.RESEND_API_KEY?.trim();
  if (!resendApiKey) {
    logger.warn(
      "Skipping monitoring email summary; RESEND_API_KEY is not set",
      {
        monitorId: params.monitor.id,
        checkId: params.check.id,
        recipients,
      },
    );
    return { attempted: false, success: true, recipients };
  }

  const payload: MonitoringEmailPayload = {
    monitorId: params.monitor.id,
    monitorName: params.monitor.name,
    checkId: params.check.id,
    summary: {
      changed: params.check.changed_count,
      new: params.check.new_count,
      removed: params.check.removed_count,
      error: params.check.error_count,
      totalPages: params.check.total_pages,
    },
    pages: params.pages,
    creditsUsed: params.check.actual_credits,
  };

  const resend = new Resend(resendApiKey);
  try {
    const { error } = await resend.emails.send({
      from: "Firecrawl <notifications@notifications.firecrawl.dev>",
      to: recipients,
      reply_to: "help@firecrawl.com",
      subject: `Monitor changes detected: ${params.monitor.name}`,
      html: buildHtml(payload),
    });

    if (error) {
      logger.warn("Monitoring email summary send failed", {
        monitorId: params.monitor.id,
        checkId: params.check.id,
        recipients,
        error,
      });
      return {
        attempted: true,
        success: false,
        recipients,
        error: typeof error === "string" ? error : JSON.stringify(error),
      };
    }

    logger.info("Monitoring email summary sent", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
      recipients,
    });

    return { attempted: true, success: true, recipients };
  } catch (error) {
    logger.warn("Failed to send monitoring email summary", { error });
    return {
      attempted: true,
      success: false,
      recipients,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
