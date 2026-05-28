import { Resend } from "resend";
import escapeHtml from "escape-html";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { supabase_service } from "../supabase";
import type { MonitorCheckRow, MonitorRow } from "../monitoring/types";
import {
  ensureMonitorEmailRecipient,
  listMonitorEmailRecipients,
  markRecipientConfirmationSent,
  normalizeRecipientEmail,
  touchRecipientsNotified,
  type MonitorEmailRecipientRow,
} from "../monitoring/email_recipients";

const logger = _logger.child({ module: "monitoring-email" });

const FROM_ADDRESS = "Firecrawl <notifications@notifications.firecrawl.dev>";
const REPLY_TO_ADDRESS = "help@firecrawl.com";

type MonitoringEmailPage = {
  url: string;
  status: string;
  error?: string | null;
  judgment?: {
    meaningful: boolean;
    confidence: "high" | "medium" | "low";
    reason: string;
    meaningfulChanges?: Array<{
      type: "added" | "removed" | "changed";
      before: string | null;
      after: string | null;
      reason: string;
    }>;
  } | null;
  diffText?: string | null;
};

const DIFF_MAX_LINES_PER_PAGE = 24;
const DIFF_MAX_CHARS_PER_LINE = 200;

function userFacingPageError(error?: string | null): string | null {
  if (!error) return null;
  return "Firecrawl could not check this page. Open the dashboard for details.";
}

function renderDiffBlock(diffText: string): string {
  const lines = diffText.split("\n");
  const truncated = lines.length > DIFF_MAX_LINES_PER_PAGE;
  const shown = lines.slice(0, DIFF_MAX_LINES_PER_PAGE).map(rawLine => {
    const clipped =
      rawLine.length > DIFF_MAX_CHARS_PER_LINE
        ? rawLine.slice(0, DIFF_MAX_CHARS_PER_LINE) + "…"
        : rawLine;
    const safe = escapeHtml(clipped);
    let color = "#374151";
    let bg = "transparent";
    if (clipped.startsWith("+") && !clipped.startsWith("+++")) {
      color = "#166534";
      bg = "#dcfce7";
    } else if (clipped.startsWith("-") && !clipped.startsWith("---")) {
      color = "#991b1b";
      bg = "#fee2e2";
    } else if (clipped.startsWith("@@")) {
      color = "#6b21a8";
    }
    return `<div style="color:${color};background:${bg};padding:0 6px;">${safe || "&nbsp;"}</div>`;
  });
  return `<pre style="margin:8px 0 0;padding:10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre;overflow-x:auto;">${shown.join("")}${truncated ? `<div style="color:#6b7280;padding:6px 6px 0;">… ${lines.length - DIFF_MAX_LINES_PER_PAGE} more lines</div>` : ""}</pre>`;
}

export type MonitoringEmailPayload = {
  monitorId: string;
  monitorName: string;
  checkId: string;
  dashboardUrl: string;
  summary: {
    changed: number;
    new: number;
    removed: number;
    error: number;
    totalPages: number;
  };
  pages: MonitoringEmailPage[];
  creditsUsed: number | null;
  // When omitted, the footer drops the unsubscribe row.
  unsubscribeUrl?: string;
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

export function buildMonitoringCheckDashboardUrl(
  params: { monitorId: string; checkId: string },
  baseUrl: string = config.FIRECRAWL_DASHBOARD_URL,
): string {
  const url = new URL(
    `/app/monitoring/${encodeURIComponent(params.monitorId)}`,
    baseUrl.trim(),
  );
  url.searchParams.set("checkId", params.checkId);
  return url.toString();
}

function buildPublicWebUrl(path: string, token: string): string {
  const base = config.FIRECRAWL_DASHBOARD_URL.trim();
  const url = new URL(path, base);
  url.searchParams.set("token", token);
  return url.toString();
}

// Email links land on the firecrawl-web pages, which POST the token to the
// API. Keeps branding consistent and stops passive link scanners (Outlook
// Safe Links, etc.) from accidentally consuming tokens with bare GETs.
export function buildRecipientConfirmationUrl(token: string): string {
  return buildPublicWebUrl("/monitoring/email/confirm", token);
}

export function buildRecipientUnsubscribeUrl(token: string): string {
  return buildPublicWebUrl("/monitoring/email/unsubscribe", token);
}

function buildUnsubscribeFooter(unsubscribeUrl: string): string {
  const safe = escapeHtml(unsubscribeUrl);
  return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;" />
<p style="color:#6b7280;font-size:12px;line-height:1.6;margin:0;">
You're receiving this because you opted in to Firecrawl monitor alerts at this address.
<a href="${safe}" style="color:#6b7280;text-decoration:underline;">Unsubscribe from this monitor</a>.
</p>`;
}

export function buildHtml(payload: MonitoringEmailPayload): string {
  const sortedPages = [...payload.pages].sort((a, b) => {
    const aMeaningful = a.judgment?.meaningful === true ? 0 : 1;
    const bMeaningful = b.judgment?.meaningful === true ? 0 : 1;
    return aMeaningful - bMeaningful;
  });

  const pageItems = sortedPages
    .slice(0, 20)
    .map(page => {
      const url = escapeHtml(page.url);
      let badge = "";
      let reason = "";
      if (page.judgment) {
        if (page.judgment.meaningful) {
          badge =
            ' <span style="color:#b45309;font-weight:600">[meaningful]</span>';
        } else {
          badge = ' <span style="color:#6b7280">[noise]</span>';
        }
        reason = `<br/><small style="color:#6b7280">${escapeHtml(page.judgment.reason)}</small>`;
      }
      const diffBlock =
        page.diffText && page.diffText.trim().length > 0
          ? renderDiffBlock(page.diffText)
          : "";
      const pageError = userFacingPageError(page.error);
      return `<li style="margin:0 0 14px;"><strong>${escapeHtml(page.status)}</strong>${badge}: <a href="${url}">${url}</a>${
        pageError ? ` &mdash; ${escapeHtml(pageError)}` : ""
      }${reason}${diffBlock}</li>`;
    })
    .join("");
  const dashboardUrl = escapeHtml(payload.dashboardUrl);

  const judgedPages = payload.pages.filter(p => p.judgment);
  const meaningfulCount = judgedPages.filter(
    p => p.judgment!.meaningful,
  ).length;
  const noiseCount = judgedPages.length - meaningfulCount;
  const changedLine =
    judgedPages.length > 0
      ? `Changed: ${payload.summary.changed} (${meaningfulCount} meaningful, ${noiseCount} noise)`
      : `Changed: ${payload.summary.changed}`;

  return `Hey there,<br/>
<p>Your Firecrawl monitor <strong>${escapeHtml(payload.monitorName)}</strong> detected activity.</p>
<ul>
  <li>${changedLine}</li>
  <li>New: ${payload.summary.new}</li>
  <li>Removed: ${payload.summary.removed}</li>
  <li>Errors: ${payload.summary.error}</li>
  <li>Total pages checked: ${payload.summary.totalPages}</li>
</ul>
${pageItems ? `<p>Top pages:</p><ul>${pageItems}</ul>` : ""}
<p><a href="${dashboardUrl}">View this check in the dashboard</a></p>
<p>Check ID: <code>${escapeHtml(payload.checkId)}</code></p>
<p>Credits used: ${payload.creditsUsed ?? "unknown"}</p>
<br/>Thanks,<br/>Firecrawl Team<br/>
${payload.unsubscribeUrl ? buildUnsubscribeFooter(payload.unsubscribeUrl) : ""}`;
}

export function buildConfirmationHtml(params: {
  monitorName: string;
  recipientEmail: string;
  confirmUrl: string;
  unsubscribeUrl: string;
}): string {
  const monitorName = escapeHtml(params.monitorName);
  const recipientEmail = escapeHtml(params.recipientEmail);
  const confirmUrl = escapeHtml(params.confirmUrl);
  const unsubscribeUrl = escapeHtml(params.unsubscribeUrl);

  return `Hey there,<br/>
<p>A Firecrawl user added <strong>${recipientEmail}</strong> as a notification recipient for the monitor <strong>${monitorName}</strong>.</p>
<p>If you'd like to receive change-detection emails for this monitor, please confirm:</p>
<p style="margin:24px 0;">
  <a href="${confirmUrl}"
     style="display:inline-block;padding:10px 18px;background:#fa5d19;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">
    Confirm subscription
  </a>
</p>
<p style="color:#6b7280;font-size:13px;line-height:1.6;">
  If that button doesn't work, copy and paste this link into your browser:<br/>
  <a href="${confirmUrl}" style="color:#fa5d19;word-break:break-all;">${confirmUrl}</a>
</p>
<p style="color:#6b7280;font-size:13px;line-height:1.6;">
  You will not receive any monitor notifications at this address until you click the link above. If you didn't expect this email you can safely ignore it, or
  <a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">block all future emails from this monitor</a>.
</p>
<br/>Thanks,<br/>Firecrawl Team<br/>`;
}

function getResendClient(): Resend | null {
  const key = config.RESEND_API_KEY?.trim();
  if (!key) return null;
  return new Resend(key);
}

export async function sendMonitoringConfirmationEmail(params: {
  recipient: MonitorEmailRecipientRow;
  monitorName: string;
}): Promise<{ attempted: boolean; success: boolean; error?: string }> {
  const resend = getResendClient();
  if (!resend) {
    logger.warn(
      "Skipping monitor opt-in email; RESEND_API_KEY is not set",
      {
        monitorId: params.recipient.monitor_id,
        recipientId: params.recipient.id,
      },
    );
    return { attempted: false, success: true };
  }

  const confirmUrl = buildRecipientConfirmationUrl(params.recipient.token);
  const unsubscribeUrl = buildRecipientUnsubscribeUrl(params.recipient.token);
  const html = buildConfirmationHtml({
    monitorName: params.monitorName,
    recipientEmail: params.recipient.email,
    confirmUrl,
    unsubscribeUrl,
  });

  try {
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: params.recipient.email,
      reply_to: REPLY_TO_ADDRESS,
      subject: `Confirm subscription: Firecrawl monitor "${params.monitorName}"`,
      html,
    });

    if (error) {
      logger.warn("Failed to send monitor confirmation email", {
        error,
        recipientId: params.recipient.id,
        monitorId: params.recipient.monitor_id,
      });
      return {
        attempted: true,
        success: false,
        error: typeof error === "string" ? error : JSON.stringify(error),
      };
    }

    await markRecipientConfirmationSent(params.recipient.id);
    logger.info("Sent monitor confirmation email", {
      recipientId: params.recipient.id,
      monitorId: params.recipient.monitor_id,
    });
    return { attempted: true, success: true };
  } catch (error) {
    logger.warn("Exception sending monitor confirmation email", {
      error,
      recipientId: params.recipient.id,
    });
    return {
      attempted: true,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type ResolvedRecipients = {
  confirmedRecipients: MonitorEmailRecipientRow[];
  pending: number;
  unsubscribed: number;
  total: number;
};

async function resolveSendableRecipients(
  monitor: MonitorRow,
): Promise<ResolvedRecipients> {
  const configEmail = monitor.notification?.email;
  const explicitConfigured = Array.isArray(configEmail?.recipients)
    ? (configEmail!.recipients as string[])
        .map(normalizeRecipientEmail)
        .filter(Boolean)
    : [];

  if (explicitConfigured.length > 0) {
    let rows = await listMonitorEmailRecipients(monitor.id);

    // Legacy monitors (configured pre-opt-in) have zero rows; bootstrap them
    // as confirmed so existing alerts keep flowing without a DB backfill.
    // Partial-row monitors keep strict gating — missing addresses stay
    // pending rather than getting auto-confirmed.
    if (rows.length === 0) {
      const legacyRows = await Promise.all(
        explicitConfigured.map(async email => {
          const { row } = await ensureMonitorEmailRecipient({
            monitorId: monitor.id,
            teamId: monitor.team_id,
            input: {
              email,
              source: "legacy",
              status: "confirmed",
            },
          });
          return row;
        }),
      );
      rows = legacyRows;
      logger.info("Bootstrapped legacy monitor recipients without DB backfill", {
        monitorId: monitor.id,
        recipients: explicitConfigured,
      });
    }

    const rowsByEmail = new Map(rows.map(r => [r.email, r]));

    const confirmedRecipients: MonitorEmailRecipientRow[] = [];
    let pending = 0;
    let unsubscribed = 0;

    for (const email of explicitConfigured) {
      const row = rowsByEmail.get(email);
      if (!row) {
        // Recipient appears in JSONB but has no opt-in row — treat as
        // pending so we never send without an explicit record.
        pending += 1;
        continue;
      }
      if (row.status === "confirmed") {
        confirmedRecipients.push(row);
      } else if (row.status === "unsubscribed") {
        unsubscribed += 1;
      } else {
        pending += 1;
      }
    }

    return {
      confirmedRecipients,
      pending,
      unsubscribed,
      total: explicitConfigured.length,
    };
  }

  // Fallback: team members (auto-confirmed; getTeamEmails still applies
  // their global notification_preferences).
  const teamEmails = await getTeamEmails(monitor.team_id);
  const syntheticRows: MonitorEmailRecipientRow[] = await Promise.all(
    teamEmails.map(async email => {
      const { row } = await ensureMonitorEmailRecipient({
        monitorId: monitor.id,
        teamId: monitor.team_id,
        input: {
          email,
          source: "team",
          status: "confirmed",
        },
      });
      return row;
    }),
  );

  return {
    confirmedRecipients: syntheticRows.filter(r => r.status === "confirmed"),
    pending: 0,
    unsubscribed: syntheticRows.filter(r => r.status === "unsubscribed").length,
    total: teamEmails.length,
  };
}

export async function sendMonitoringEmailSummary(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  pages: MonitoringEmailPage[];
}): Promise<{
  attempted: boolean;
  success: boolean;
  recipients: string[];
  pendingRecipients?: number;
  unsubscribedRecipients?: number;
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

  // Trust judgment-based suppression only when the changed page list is
  // complete (a missed meaningful alert is worse than a noisy one).
  if (params.monitor.judge_enabled && params.monitor.goal) {
    const changedPages = params.pages.filter(p => p.status === "changed");
    const nonChangedActivity = params.pages.some(
      p => p.status === "new" || p.status === "removed" || p.status === "error",
    );
    const changedListComplete =
      changedPages.length >= params.check.changed_count;
    if (changedPages.length > 0 && !nonChangedActivity && changedListComplete) {
      const anyMeaningful = changedPages.some(
        p => p.judgment?.meaningful === true || !p.judgment,
      );
      if (!anyMeaningful) {
        logger.info(
          "Skipping monitoring email summary; all changed pages judged noise",
          {
            monitorId: params.monitor.id,
            checkId: params.check.id,
            changedCount: changedPages.length,
          },
        );
        return { attempted: false, success: true, recipients: [] };
      }
    } else if (
      changedPages.length > 0 &&
      !nonChangedActivity &&
      !changedListComplete
    ) {
      logger.info(
        "Skipping judge-based email gating; changed-page list is truncated",
        {
          monitorId: params.monitor.id,
          checkId: params.check.id,
          changedSeen: changedPages.length,
          changedTotal: params.check.changed_count,
        },
      );
    }
  }

  const resolved = await resolveSendableRecipients(params.monitor);
  if (resolved.confirmedRecipients.length === 0) {
    logger.info(
      "Skipping monitoring email summary; no confirmed recipients",
      {
        monitorId: params.monitor.id,
        checkId: params.check.id,
        configured: resolved.total,
        pending: resolved.pending,
        unsubscribed: resolved.unsubscribed,
      },
    );
    return {
      attempted: false,
      success: true,
      recipients: [],
      pendingRecipients: resolved.pending,
      unsubscribedRecipients: resolved.unsubscribed,
    };
  }

  const resend = getResendClient();
  if (!resend) {
    logger.warn(
      "Skipping monitoring email summary; RESEND_API_KEY is not set",
      {
        monitorId: params.monitor.id,
        checkId: params.check.id,
        recipients: resolved.confirmedRecipients.map(r => r.email),
      },
    );
    return {
      attempted: false,
      success: true,
      recipients: resolved.confirmedRecipients.map(r => r.email),
      pendingRecipients: resolved.pending,
      unsubscribedRecipients: resolved.unsubscribed,
    };
  }

  const dashboardUrl = buildMonitoringCheckDashboardUrl({
    monitorId: params.monitor.id,
    checkId: params.check.id,
  });

  // One email per recipient: unique unsubscribe links + no recipient leakage.
  const sendResults = await Promise.all(
    resolved.confirmedRecipients.map(async recipient => {
      const payload: MonitoringEmailPayload = {
        monitorId: params.monitor.id,
        monitorName: params.monitor.name,
        checkId: params.check.id,
        dashboardUrl,
        summary: {
          changed: params.check.changed_count,
          new: params.check.new_count,
          removed: params.check.removed_count,
          error: params.check.error_count,
          totalPages: params.check.total_pages,
        },
        pages: params.pages,
        creditsUsed: params.check.actual_credits,
        unsubscribeUrl: buildRecipientUnsubscribeUrl(recipient.token),
      };

      try {
        const { error } = await resend.emails.send({
          from: FROM_ADDRESS,
          to: recipient.email,
          reply_to: REPLY_TO_ADDRESS,
          subject: `Monitor changes detected: ${params.monitor.name}`,
          html: buildHtml(payload),
        });
        if (error) {
          return {
            recipient,
            success: false,
            error:
              typeof error === "string" ? error : JSON.stringify(error),
          };
        }
        return { recipient, success: true };
      } catch (error) {
        return {
          recipient,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const succeededIds = sendResults
    .filter(r => r.success)
    .map(r => r.recipient.id);
  const failures = sendResults.filter(r => !r.success);
  const allRecipientEmails = resolved.confirmedRecipients.map(r => r.email);

  if (succeededIds.length > 0) {
    await touchRecipientsNotified(succeededIds);
  }

  if (failures.length === allRecipientEmails.length) {
    const errorSummary = failures
      .map(f => `${f.recipient.email}: ${f.error}`)
      .join("; ");
    logger.warn("Monitor email summary failed for all recipients", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
      failures: errorSummary,
    });
    return {
      attempted: true,
      success: false,
      recipients: allRecipientEmails,
      pendingRecipients: resolved.pending,
      unsubscribedRecipients: resolved.unsubscribed,
      error: errorSummary,
    };
  }

  if (failures.length > 0) {
    logger.warn("Monitor email summary partially failed", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
      delivered: succeededIds.length,
      failed: failures.length,
    });
  } else {
    logger.info("Monitor email summary sent", {
      monitorId: params.monitor.id,
      checkId: params.check.id,
      recipients: allRecipientEmails,
    });
  }

  return {
    attempted: true,
    success: true,
    recipients: allRecipientEmails,
    pendingRecipients: resolved.pending,
    unsubscribedRecipients: resolved.unsubscribed,
  };
}
