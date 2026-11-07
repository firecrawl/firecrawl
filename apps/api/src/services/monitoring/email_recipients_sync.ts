import { logger as _logger } from "../../lib/logger";
import { sendMonitoringConfirmationEmail } from "../notification/monitoring_email";
import {
  ensureMonitorEmailRecipient,
  getTeamMemberEmails,
  listMonitorEmailRecipients,
  normalizeRecipientEmail,
  type MonitorEmailRecipientRow,
} from "./email_recipients";
import type { MonitorRow } from "./types";

const logger = _logger.child({ module: "monitor-email-recipients-sync" });

type SyncedRecipient = {
  email: string;
  status: MonitorEmailRecipientRow["status"];
  source: MonitorEmailRecipientRow["source"];
  confirmationEmailSent: boolean;
  created: boolean;
};

type SyncResult = {
  recipients: SyncedRecipient[];
};

// Team members → auto-confirmed. External addresses → pending + confirmation
// email. Existing rows are preserved (so a quick remove-then-re-add doesn't
// undo a prior unsubscribe or re-send a confirmation).
export async function syncMonitorEmailRecipients(params: {
  monitor: MonitorRow;
}): Promise<SyncResult> {
  const configured = params.monitor.notification?.email?.recipients ?? [];
  const normalized = Array.from(
    new Set(
      configured.map(normalizeRecipientEmail).filter(email => email.length > 0),
    ),
  );

  if (normalized.length === 0) {
    return { recipients: [] };
  }

  const [existingRows, teamMatches] = await Promise.all([
    listMonitorEmailRecipients(params.monitor.id),
    getTeamMemberEmails(params.monitor.team_id, normalized),
  ]);
  const existingByEmail = new Map(existingRows.map(r => [r.email, r]));

  const results: SyncedRecipient[] = [];

  for (const email of normalized) {
    const existing = existingByEmail.get(email);
    if (existing) {
      results.push({
        email: existing.email,
        status: existing.status,
        source: existing.source,
        confirmationEmailSent: existing.confirmation_sent_at !== null,
        created: false,
      });
      continue;
    }

    const isTeamMember = teamMatches.has(email);
    const { row, created } = await ensureMonitorEmailRecipient({
      monitorId: params.monitor.id,
      teamId: params.monitor.team_id,
      input: {
        email,
        source: isTeamMember ? "team" : "opt_in",
        status: isTeamMember ? "confirmed" : "pending",
      },
    });

    let confirmationEmailSent = false;
    if (created && !isTeamMember && row.status === "pending") {
      const sendResult = await sendMonitoringConfirmationEmail({
        recipient: row,
        monitorName: params.monitor.name,
      }).catch(error => {
        logger.warn("Confirmation email send threw", {
          error,
          recipientId: row.id,
          monitorId: params.monitor.id,
        });
        return { attempted: true, success: false } as const;
      });
      confirmationEmailSent = sendResult.attempted && sendResult.success;
    }

    results.push({
      email: row.email,
      status: row.status,
      source: row.source,
      confirmationEmailSent,
      created,
    });
  }

  return { recipients: results };
}
