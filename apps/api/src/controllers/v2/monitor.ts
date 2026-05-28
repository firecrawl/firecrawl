import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { RequestWithAuth } from "./types";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { getMonitorDiffArtifact } from "../../lib/gcs-monitoring";
import {
  createMonitorSchema,
  listMonitorChecksQuerySchema,
  listMonitorsQuerySchema,
  monitorCheckDetailQuerySchema,
  updateMonitorSchema,
} from "../../services/monitoring/types";
import {
  createMonitor,
  createMonitorCheck,
  countMonitorCheckPages,
  deleteMonitor,
  estimateMonitorCreditsPerRun,
  getMonitor,
  getMonitorCheck,
  getMonitorForUpdate,
  listMonitorCheckPages,
  listMonitorChecks,
  listMonitors,
  updateMonitor,
} from "../../services/monitoring/store";
import { enqueueMonitorCheck } from "../../services/monitoring/scheduler";
import {
  estimateRunsPerMonth,
  validateMonitorCron,
} from "../../services/monitoring/cron";
import {
  getRemovedMonitorTargets,
  trackMonitorConfiguredInterest,
  trackMonitorDeactivatedInterest,
} from "../../services/monitoring/interest";
import {
  getLatestWebhookLog,
  getLatestWebhookLogsByJob,
  type WebhookLogRow,
} from "../../services/webhook/logs";
import { WebhookEvent } from "../../services/webhook";
import {
  confirmRecipientByToken,
  getMonitorNameById,
  listMonitorEmailRecipients,
  unsubscribeRecipientByToken,
} from "../../services/monitoring/email_recipients";
import { syncMonitorEmailRecipients } from "../../services/monitoring/email_recipients_sync";

const logger = _logger.child({ module: "monitor-controller" });

const monitorParamsSchema = z.strictObject({
  monitorId: z.uuid(),
});

const monitorCheckParamsSchema = monitorParamsSchema.extend({
  checkId: z.uuid(),
});

function rejectZdr(
  req: RequestWithAuth<any, any, any>,
  res: Response,
): boolean {
  if (getScrapeZDR(req.acuc?.flags) === "forced") {
    res.status(400).json({
      success: false,
      error:
        "Monitoring requires retained snapshots and diffs, and is not supported for zero data retention teams.",
    });
    return true;
  }
  return false;
}

function serializeMonitor(
  monitor: any,
  options?: {
    emailRecipientSubscriptions?: Array<{
      email: string;
      status: "pending" | "confirmed" | "unsubscribed";
      source: "team" | "opt_in" | "legacy";
      confirmationEmailSent?: boolean;
    }>;
  },
) {
  return {
    id: monitor.id,
    name: monitor.name,
    status: monitor.status,
    schedule: {
      cron: monitor.schedule_cron,
      timezone: monitor.schedule_timezone,
    },
    nextRunAt: monitor.next_run_at,
    lastRunAt: monitor.last_run_at,
    currentCheckId: monitor.current_check_id,
    targets: monitor.targets,
    webhook: monitor.webhook,
    notification: monitor.notification,
    ...(options?.emailRecipientSubscriptions !== undefined
      ? { emailRecipientSubscriptions: options.emailRecipientSubscriptions }
      : {}),
    retentionDays: monitor.retention_days,
    estimatedCreditsPerMonth: monitor.estimated_credits_per_month,
    lastCheckSummary: monitor.last_check_summary,
    goal: monitor.goal ?? null,
    judgeEnabled: Boolean(monitor.judge_enabled),
    createdAt: monitor.created_at,
    updatedAt: monitor.updated_at,
  };
}

async function loadEmailRecipientSubscriptions(monitorId: string) {
  const rows = await listMonitorEmailRecipients(monitorId);
  return rows.map(r => ({
    email: r.email,
    status: r.status,
    source: r.source,
    confirmationEmailSent: r.confirmation_sent_at !== null,
  }));
}

function overlayWebhookLog<T extends { notificationStatus: any }>(
  serialized: T,
  log: WebhookLogRow | null,
): T {
  if (!log) return serialized;
  const notificationStatus =
    serialized.notificationStatus &&
    typeof serialized.notificationStatus === "object"
      ? serialized.notificationStatus
      : {};
  const existing =
    notificationStatus.webhook && typeof notificationStatus.webhook === "object"
      ? notificationStatus.webhook
      : {};
  return {
    ...serialized,
    notificationStatus: {
      ...notificationStatus,
      webhook: {
        ...existing,
        attempted: true,
        success: log.success === true,
        delivered: log.success === true,
        queued: false,
        statusCode: log.status_code ?? undefined,
        error: log.error ?? undefined,
        deliveredAt: log.created_at,
      },
    },
  };
}

function serializeCheck(check: any) {
  return {
    id: check.id,
    monitorId: check.monitor_id,
    status: check.status,
    trigger: check.trigger,
    scheduledFor: check.scheduled_for,
    startedAt: check.started_at,
    finishedAt: check.finished_at,
    estimatedCredits: check.estimated_credits,
    reservedCredits: check.reserved_credits,
    actualCredits: check.actual_credits,
    billingStatus: check.billing_status,
    summary: {
      totalPages: check.total_pages,
      same: check.same_count,
      changed: check.changed_count,
      new: check.new_count,
      removed: check.removed_count,
      error: check.error_count,
    },
    targetResults: check.target_results,
    notificationStatus: check.notification_status,
    error: check.error,
    createdAt: check.created_at,
    updatedAt: check.updated_at,
  };
}

export async function createMonitorController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
) {
  if (rejectZdr(req, res)) return;

  const input = createMonitorSchema.parse(req.body);
  let schedule;
  try {
    schedule = validateMonitorCron(
      input.schedule.cron,
      input.schedule.timezone,
    );
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const monitor = await createMonitor({
    teamId: req.auth.team_id,
    input,
    nextRunAt: schedule.nextRunAt,
    intervalMs: schedule.intervalMs,
  });

  trackMonitorConfiguredInterest({
    monitor,
    intervalMs: schedule.intervalMs,
  }).catch(error =>
    logger.warn("Failed to track monitor target interest", {
      error,
      monitorId: monitor.id,
      eventType: "configured",
    }),
  );

  const sync = await syncMonitorEmailRecipients({ monitor }).catch(error => {
    logger.warn("Failed to sync monitor email recipients on create", {
      error,
      monitorId: monitor.id,
    });
    return { recipients: [] };
  });

  res.status(200).json({
    success: true,
    data: serializeMonitor(monitor, {
      emailRecipientSubscriptions: sync.recipients,
    }),
  });
}

export async function listMonitorsController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
) {
  const query = listMonitorsQuerySchema.parse(req.query);
  const monitors = await listMonitors({
    teamId: req.auth.team_id,
    limit: query.limit,
    offset: query.offset,
  });

  res.status(200).json({
    success: true,
    data: monitors.map(monitor => serializeMonitor(monitor)),
  });
}

export async function getMonitorController(
  req: RequestWithAuth<{ monitorId: string }, any, unknown>,
  res: Response,
) {
  const { monitorId } = monitorParamsSchema.parse(req.params);
  const monitor = await getMonitor(req.auth.team_id, monitorId);
  if (!monitor) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }

  const subscriptions = await loadEmailRecipientSubscriptions(monitorId).catch(
    error => {
      logger.warn("Failed to load email recipient subscriptions", {
        error,
        monitorId,
      });
      return [];
    },
  );

  res.status(200).json({
    success: true,
    data: serializeMonitor(monitor, {
      emailRecipientSubscriptions: subscriptions,
    }),
  });
}

export async function updateMonitorController(
  req: RequestWithAuth<{ monitorId: string }, any, unknown>,
  res: Response,
) {
  if (rejectZdr(req, res)) return;

  const { monitorId } = monitorParamsSchema.parse(req.params);
  const existing = await getMonitorForUpdate(req.auth.team_id, monitorId);
  if (!existing) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }

  const input = updateMonitorSchema.parse(req.body);
  const cron = input.schedule?.cron ?? existing.schedule_cron;
  const timezone = input.schedule?.timezone ?? existing.schedule_timezone;
  let schedule;
  try {
    schedule = validateMonitorCron(cron, timezone);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const monitor = await updateMonitor({
    teamId: req.auth.team_id,
    monitorId,
    input,
    nextRunAt: input.schedule ? schedule.nextRunAt : undefined,
    intervalMs:
      input.schedule || input.targets ? schedule.intervalMs : undefined,
  });
  if (!monitor) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }

  const interestTracking: Promise<void>[] = [];
  const removedTargets = input.targets
    ? getRemovedMonitorTargets({ before: existing, after: monitor })
    : [];
  if (removedTargets.length > 0) {
    interestTracking.push(
      trackMonitorDeactivatedInterest({
        monitor: existing,
        targets: removedTargets,
      }),
    );
  }
  if (
    monitor.status === "paused" &&
    (input.status === "paused" || input.schedule || input.targets)
  ) {
    interestTracking.push(
      trackMonitorDeactivatedInterest({
        monitor,
        intervalMs: schedule.intervalMs,
      }),
    );
  } else if (input.schedule || input.targets || input.status === "active") {
    interestTracking.push(
      trackMonitorConfiguredInterest({
        monitor,
        intervalMs: schedule.intervalMs,
      }),
    );
  }
  Promise.all(interestTracking).catch(error =>
    logger.warn("Failed to track monitor target interest", {
      error,
      monitorId: monitor.id,
      eventType: "update",
    }),
  );

  // Only re-sync when notification config actually changed.
  let subscriptions: Awaited<
    ReturnType<typeof loadEmailRecipientSubscriptions>
  > = [];
  if (input.notification !== undefined) {
    const sync = await syncMonitorEmailRecipients({ monitor }).catch(error => {
      logger.warn("Failed to sync monitor email recipients on update", {
        error,
        monitorId: monitor.id,
      });
      return { recipients: [] };
    });
    subscriptions = sync.recipients;
  } else {
    subscriptions = await loadEmailRecipientSubscriptions(monitor.id);
  }

  res.status(200).json({
    success: true,
    data: serializeMonitor(monitor, {
      emailRecipientSubscriptions: subscriptions,
    }),
  });
}

export async function deleteMonitorController(
  req: RequestWithAuth<{ monitorId: string }, any, unknown>,
  res: Response,
) {
  const { monitorId } = monitorParamsSchema.parse(req.params);
  const existing = await getMonitorForUpdate(req.auth.team_id, monitorId);
  if (!existing) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }

  const deleted = await deleteMonitor({
    teamId: req.auth.team_id,
    monitorId,
  });
  if (!deleted) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }

  trackMonitorDeactivatedInterest({
    monitor: { ...existing, status: "deleted" },
  }).catch(error =>
    logger.warn("Failed to track monitor target interest", {
      error,
      monitorId,
      eventType: "deactivated",
    }),
  );

  res.status(200).json({ success: true });
}

export async function runMonitorController(
  req: RequestWithAuth<{ monitorId: string }, any, unknown>,
  res: Response,
) {
  if (rejectZdr(req, res)) return;

  const { monitorId } = monitorParamsSchema.parse(req.params);
  const monitor = await getMonitorForUpdate(req.auth.team_id, monitorId);
  if (!monitor) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }
  if (monitor.current_check_id) {
    return res.status(409).json({
      success: false,
      error: "Monitor check is already running.",
      checkId: monitor.current_check_id,
    });
  }

  const check = await createMonitorCheck({
    monitor,
    trigger: "manual",
  });
  await enqueueMonitorCheck({
    monitorId: monitor.id,
    checkId: check.id,
    teamId: monitor.team_id,
  });

  res.status(200).json({
    success: true,
    id: check.id,
    data: serializeCheck(check),
  });
}

export async function listMonitorChecksController(
  req: RequestWithAuth<{ monitorId: string }, any, unknown>,
  res: Response,
) {
  const { monitorId } = monitorParamsSchema.parse(req.params);
  const monitor = await getMonitor(req.auth.team_id, monitorId);
  if (!monitor) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }

  const query = listMonitorChecksQuerySchema.parse(req.query);
  const checks = await listMonitorChecks({
    teamId: req.auth.team_id,
    monitorId,
    limit: query.limit,
    offset: query.offset,
    status: query.status,
  });

  const webhookLogs = await getLatestWebhookLogsByJob({
    jobIds: checks.map(c => c.id),
    event: WebhookEvent.MONITOR_CHECK_COMPLETED,
  });

  res.status(200).json({
    success: true,
    data: checks.map(check =>
      overlayWebhookLog(
        serializeCheck(check),
        webhookLogs.get(check.id) ?? null,
      ),
    ),
  });
}

export async function getMonitorCheckController(
  req: RequestWithAuth<{ monitorId: string; checkId: string }, any, unknown>,
  res: Response,
) {
  const { monitorId, checkId } = monitorCheckParamsSchema.parse(req.params);
  const query = monitorCheckDetailQuerySchema.parse(req.query);
  const skip = query.skip;
  const check = await getMonitorCheck(req.auth.team_id, monitorId, checkId);
  if (!check) {
    return res.status(404).json({ success: false, error: "Check not found" });
  }

  const [pages, totalPagesForFilter, webhookLog] = await Promise.all([
    listMonitorCheckPages({
      teamId: req.auth.team_id,
      monitorId,
      checkId,
      limit: query.limit,
      skip,
      status: query.status,
    }),
    countMonitorCheckPages({
      checkId,
      status: query.status,
    }),
    getLatestWebhookLog({
      jobId: checkId,
      event: WebhookEvent.MONITOR_CHECK_COMPLETED,
    }),
  ]);

  const pagesWithDiffs = await Promise.all(
    pages.map(async page => {
      const artifact = await getMonitorDiffArtifact(page.diff_gcs_key);
      const base = {
        id: page.id,
        targetId: page.target_id,
        url: page.url,
        status: page.status,
        previousScrapeId: page.previous_scrape_id,
        currentScrapeId: page.current_scrape_id,
        statusCode: page.status_code,
        error: page.error,
        metadata: page.metadata,
        judgment: page.judgment ?? null,
        createdAt: page.created_at,
      };
      if (!artifact) {
        return { ...base, diff: null };
      }
      if (artifact.kind === "json") {
        return {
          ...base,
          diff: {
            json: artifact.json,
            ...(artifact.markdown ? { text: artifact.markdown.text } : {}),
          },
          snapshot: { json: artifact.snapshot },
        };
      }
      return {
        ...base,
        diff: { text: artifact.text, json: artifact.json },
      };
    }),
  );
  const nextSkip = skip + pagesWithDiffs.length;
  const next = (() => {
    if (totalPagesForFilter <= nextSkip) return undefined;
    const url = new URL(
      `/v2/monitor/${monitorId}/checks/${checkId}`,
      `${req.protocol}://${req.get("host")}`,
    );
    url.searchParams.set("skip", String(nextSkip));
    url.searchParams.set("limit", String(query.limit));
    if (query.status) url.searchParams.set("status", query.status);
    return url.toString();
  })();

  res.status(200).json({
    success: true,
    next,
    data: {
      ...overlayWebhookLog(serializeCheck(check), webhookLog),
      pages: pagesWithDiffs,
      next,
    },
  });
}

// Unauthenticated POST endpoints — the token is the credential. Backs the
// firecrawl-web confirm/unsubscribe pages; POST-only so passive GET scanners
// can't consume tokens against the dashboard URL.

const emailActionBodySchema = z.object({
  // 32-byte base64url is 43 chars; range leaves room for future formats.
  token: z.string().min(16).max(64),
});

type EmailActionResponse =
  | {
      success: true;
      result: "confirmed" | "already_confirmed" | "unsubscribed" | "already_unsubscribed";
      email: string;
      monitorName: string | null;
    }
  | {
      success: false;
      error: "invalid_token" | "not_found" | "internal_error";
    };


function parseTokenFromRequest(req: { body?: unknown }): string | null {
  const candidate =
    req.body && typeof req.body === "object"
      ? (req.body as { token?: unknown }).token
      : null;
  const parsed = emailActionBodySchema.safeParse({ token: candidate });
  return parsed.success ? parsed.data.token : null;
}

export async function confirmMonitorEmailController(
  req: { body?: unknown },
  res: Response,
) {
  const token = parseTokenFromRequest(req);
  if (!token) {
    const body: EmailActionResponse = {
      success: false,
      error: "invalid_token",
    };
    return res.status(400).json(body);
  }

  try {
    const row = await confirmRecipientByToken(token);
    if (!row) {
      const body: EmailActionResponse = {
        success: false,
        error: "not_found",
      };
      return res.status(404).json(body);
    }

    const monitorName = await getMonitorNameById(row.monitor_id);

    // Heuristic: if confirmed_at is older than 5s, this call was a no-op
    // (already confirmed). Used only to flavor the rendered page.
    let result: "confirmed" | "already_confirmed" | "already_unsubscribed";
    if (row.status === "unsubscribed") {
      result = "already_unsubscribed";
    } else if (
      row.confirmed_at !== null &&
      new Date().getTime() - new Date(row.confirmed_at).getTime() > 5_000
    ) {
      result = "already_confirmed";
    } else {
      result = "confirmed";
    }

    const body: EmailActionResponse = {
      success: true,
      result,
      email: row.email,
      monitorName,
    };
    return res.status(200).json(body);
  } catch (error) {
    logger.error("Failed to confirm monitor email recipient", { error });
    const body: EmailActionResponse = {
      success: false,
      error: "internal_error",
    };
    return res.status(500).json(body);
  }
}

export async function unsubscribeMonitorEmailController(
  req: { body?: unknown },
  res: Response,
) {
  const token = parseTokenFromRequest(req);
  if (!token) {
    const body: EmailActionResponse = {
      success: false,
      error: "invalid_token",
    };
    return res.status(400).json(body);
  }

  try {
    const row = await unsubscribeRecipientByToken(token);
    if (!row) {
      const body: EmailActionResponse = {
        success: false,
        error: "not_found",
      };
      return res.status(404).json(body);
    }

    const monitorName = await getMonitorNameById(row.monitor_id);

    const result: "unsubscribed" | "already_unsubscribed" =
      row.unsubscribed_at !== null &&
      new Date().getTime() - new Date(row.unsubscribed_at).getTime() > 5_000
        ? "already_unsubscribed"
        : "unsubscribed";

    const body: EmailActionResponse = {
      success: true,
      result,
      email: row.email,
      monitorName,
    };
    return res.status(200).json(body);
  } catch (error) {
    logger.error("Failed to unsubscribe monitor email recipient", { error });
    const body: EmailActionResponse = {
      success: false,
      error: "internal_error",
    };
    return res.status(500).json(body);
  }
}
