import { Response } from "express";
import { z } from "zod";
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

function serializeMonitor(monitor: any) {
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
    retentionDays: monitor.retention_days,
    estimatedCreditsPerMonth: monitor.estimated_credits_per_month,
    lastCheckSummary: monitor.last_check_summary,
    createdAt: monitor.created_at,
    updatedAt: monitor.updated_at,
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

  res.status(200).json({
    success: true,
    data: serializeMonitor(monitor),
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
    data: monitors.map(serializeMonitor),
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

  res.status(200).json({
    success: true,
    data: serializeMonitor(monitor),
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

  res.status(200).json({
    success: true,
    data: serializeMonitor(monitor),
  });
}

export async function deleteMonitorController(
  req: RequestWithAuth<{ monitorId: string }, any, unknown>,
  res: Response,
) {
  const { monitorId } = monitorParamsSchema.parse(req.params);
  const deleted = await deleteMonitor({
    teamId: req.auth.team_id,
    monitorId,
  });
  if (!deleted) {
    return res.status(404).json({ success: false, error: "Monitor not found" });
  }

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

  res.status(200).json({
    success: true,
    data: checks.map(serializeCheck),
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

  const [pages, totalPagesForFilter] = await Promise.all([
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
  ]);

  const pagesWithDiffs = await Promise.all(
    pages.map(async page => ({
      id: page.id,
      targetId: page.target_id,
      url: page.url,
      status: page.status,
      previousScrapeId: page.previous_scrape_id,
      currentScrapeId: page.current_scrape_id,
      statusCode: page.status_code,
      error: page.error,
      metadata: page.metadata,
      diff: await getMonitorDiffArtifact(page.diff_gcs_key),
      createdAt: page.created_at,
    })),
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
      ...serializeCheck(check),
      pages: pagesWithDiffs,
      next,
    },
  });
}
