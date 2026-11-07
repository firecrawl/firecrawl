import { trackMonitorTargetInterest } from "../../lib/tracking";
import { validateMonitorCron } from "./cron";
import type { MonitorCheckRow, MonitorRow, MonitorTarget } from "./types";

function monitorIntervalMs(monitor: MonitorRow): number {
  return validateMonitorCron(monitor.schedule_cron, monitor.schedule_timezone)
    .intervalMs;
}

function interestTargets(monitor: MonitorRow): MonitorTarget[] {
  return monitor.targets ?? [];
}

export function getRemovedMonitorTargets(params: {
  before: MonitorRow;
  after: MonitorRow;
}): MonitorTarget[] {
  const afterIds = new Set(
    interestTargets(params.after).map(target => target.id),
  );
  return interestTargets(params.before).filter(
    target => !afterIds.has(target.id),
  );
}

export async function trackMonitorConfiguredInterest(params: {
  monitor: MonitorRow;
  intervalMs?: number;
}): Promise<void> {
  await trackMonitorTargetInterest({
    eventType: "configured",
    teamId: params.monitor.team_id,
    monitorId: params.monitor.id,
    monitorStatus: params.monitor.status,
    scheduleCron: params.monitor.schedule_cron,
    scheduleTimezone: params.monitor.schedule_timezone,
    intervalMs: params.intervalMs ?? monitorIntervalMs(params.monitor),
    targets: interestTargets(params.monitor),
    zeroDataRetention: false,
  });
}

export async function trackMonitorDeactivatedInterest(params: {
  monitor: MonitorRow;
  targets?: MonitorTarget[];
  intervalMs?: number;
}): Promise<void> {
  await trackMonitorTargetInterest({
    eventType: "deactivated",
    teamId: params.monitor.team_id,
    monitorId: params.monitor.id,
    monitorStatus: params.monitor.status,
    scheduleCron: params.monitor.schedule_cron,
    scheduleTimezone: params.monitor.schedule_timezone,
    intervalMs: params.intervalMs ?? monitorIntervalMs(params.monitor),
    targets: params.targets ?? interestTargets(params.monitor),
    zeroDataRetention: false,
  });
}

export async function trackMonitorCheckStartedInterest(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
}): Promise<void> {
  await trackMonitorTargetInterest({
    eventType: "check_started",
    teamId: params.monitor.team_id,
    monitorId: params.monitor.id,
    monitorStatus: params.monitor.status,
    scheduleCron: params.monitor.schedule_cron,
    scheduleTimezone: params.monitor.schedule_timezone,
    intervalMs: monitorIntervalMs(params.monitor),
    targets: interestTargets(params.monitor),
    checkId: params.check.id,
    zeroDataRetention: false,
  });
}
