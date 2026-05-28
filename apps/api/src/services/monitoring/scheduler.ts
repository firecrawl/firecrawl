import { randomUUID } from "crypto";
import { logger as _logger } from "../../lib/logger";
import { addMonitorCheckJob } from "./queue";
import {
  advanceMonitorAfterSkippedCheck,
  claimDueMonitors,
  createMonitorCheck,
  deferMonitorClaim,
  dispatchScheduledMonitorCheck,
  getMonitorCheck,
  updateMonitorCheck,
  updateMonitorScheduleAfterRun,
} from "./store";
import { autumnService } from "../autumn/autumn.service";
import { isMonitorCheckStale, MONITOR_CHECK_STALE_ERROR } from "./stale";
import { validateMonitorCron } from "./cron";
import { monitorJitterOffsetMs } from "./jitter";
import type { MonitorRow } from "./types";

const logger = _logger.child({ module: "monitoring-scheduler" });

export async function enqueueMonitorCheck(params: {
  monitorId: string;
  checkId: string;
  teamId: string;
}): Promise<void> {
  await addMonitorCheckJob(params);
}

export async function enqueueDueMonitorChecks(
  params: {
    workerId?: string;
    limit?: number;
    leaseSeconds?: number;
  } = {},
): Promise<number> {
  const workerId = params.workerId ?? `monitor-scheduler-${randomUUID()}`;
  const monitors = await claimDueMonitors({
    workerId,
    limit: params.limit ?? 10,
    leaseSeconds: params.leaseSeconds ?? 60,
  });

  let enqueued = 0;
  for (let monitor of monitors) {
    let check: Awaited<ReturnType<typeof createMonitorCheck>> | null = null;
    let dispatched = false;
    try {
      if (await deferForJitter(monitor)) continue;

      if (monitor.current_check_id) {
        const cleared = await clearFinishedOrStaleCurrentCheck(monitor);
        if (cleared) {
          monitor = { ...monitor, current_check_id: null };
        }
      }

      if (monitor.current_check_id) {
        const skipped = await createMonitorCheck({
          monitor,
          trigger: "scheduled",
          scheduledFor: monitor.next_run_at,
          status: "skipped_overlap",
        });
        const finished = await updateMonitorCheck(skipped.id, {
          status: "skipped_overlap",
          finished_at: new Date().toISOString(),
          error: "Previous monitor check is still running.",
        });
        await advanceMonitorAfterSkippedCheck({ monitor, check: finished });
        continue;
      }

      check = await createMonitorCheck({
        monitor,
        trigger: "scheduled",
        scheduledFor: monitor.next_run_at,
      });
      dispatched = await dispatchScheduledMonitorCheck({
        monitor,
        checkId: check.id,
      });
      if (!dispatched) {
        check = await updateMonitorCheck(check.id, {
          status: "skipped_overlap",
          finished_at: new Date().toISOString(),
          error: "Previous monitor check is still running.",
        });
        await advanceMonitorAfterSkippedCheck({ monitor, check });
        continue;
      }

      await enqueueMonitorCheck({
        monitorId: monitor.id,
        checkId: check.id,
        teamId: monitor.team_id,
      });
      enqueued++;
    } catch (error) {
      if (check) {
        const failed = await updateMonitorCheck(check.id, {
          status: "failed",
          finished_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }).catch(updateError => {
          logger.error("Failed to mark monitor check enqueue failure", {
            updateError,
            error,
            monitorId: monitor.id,
            checkId: check?.id,
            teamId: monitor.team_id,
          });
          return null;
        });

        if (failed && dispatched) {
          await updateMonitorScheduleAfterRun({
            monitor,
            check: failed,
          }).catch(updateError => {
            logger.error("Failed to clear failed dispatched monitor check", {
              updateError,
              error,
              monitorId: monitor.id,
              checkId: failed.id,
              teamId: monitor.team_id,
            });
          });
        }
      }

      logger.error("Failed to enqueue due monitor check", {
        error,
        monitorId: monitor.id,
        teamId: monitor.team_id,
      });
    }
  }

  return enqueued;
}

async function deferForJitter(monitor: MonitorRow): Promise<boolean> {
  if (!monitor.next_run_at) return false;
  const { intervalMs } = validateMonitorCron(
    monitor.schedule_cron,
    monitor.schedule_timezone,
  );
  const dueAt =
    new Date(monitor.next_run_at).getTime() +
    monitorJitterOffsetMs(monitor.id, intervalMs);
  if (Date.now() >= dueAt) return false;
  try {
    await deferMonitorClaim(monitor.id, new Date(dueAt));
  } catch (error) {
    logger.warn("Failed to defer monitor claim for jitter", {
      error,
      monitorId: monitor.id,
    });
    return false;
  }
  return true;
}

async function clearFinishedOrStaleCurrentCheck(
  monitor: MonitorRow,
): Promise<boolean> {
  if (!monitor.current_check_id) return true;

  const current = await getMonitorCheck(
    monitor.team_id,
    monitor.id,
    monitor.current_check_id,
  );
  if (!current) return false;

  if (current.status === "running" || current.status === "queued") {
    if (!isMonitorCheckStale(current)) return false;

    if (current.autumn_lock_id) {
      await autumnService
        .finalizeCreditsLock({
          lockId: current.autumn_lock_id,
          action: "release",
          properties: {
            source: "monitorCheck",
            endpoint: "monitor",
            jobId: current.id,
          },
        })
        .catch(error => {
          logger.warn("Failed to release stale monitor check credit lock", {
            error,
            monitorId: monitor.id,
            checkId: current.id,
            lockId: current.autumn_lock_id,
          });
        });
    }

    const failed = await updateMonitorCheck(current.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      actual_credits: 0,
      billing_status: current.autumn_lock_id ? "released" : "not_applicable",
      error: MONITOR_CHECK_STALE_ERROR,
    });
    await updateMonitorScheduleAfterRun({
      monitor,
      check: failed,
    });
    return true;
  }

  await updateMonitorScheduleAfterRun({
    monitor,
    check: current,
  });
  return true;
}
