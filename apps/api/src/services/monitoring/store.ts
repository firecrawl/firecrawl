import { createHash } from "crypto";
import { v7 as uuidv7 } from "uuid";
import { supabase_rr_service, supabase_service } from "../supabase";
import {
  getNextMonitorRunAt,
  estimateRunsPerMonth,
  validateMonitorCron,
} from "./cron";
import type {
  CreateMonitorRequest,
  MonitorCheckPageInsert,
  MonitorCheckRow,
  MonitorPageRow,
  MonitorRow,
  MonitorSummary,
  MonitorTarget,
  UpdateMonitorRequest,
} from "./types";

export function hashMonitorUrl(url: string): string {
  return `\\x${createHash("sha256").update(url).digest("hex")}`;
}

function ensureTargetIds(targets: Array<Record<string, any>>): MonitorTarget[] {
  return targets.map(target => ({
    ...target,
    id: typeof target.id === "string" ? target.id : uuidv7(),
  })) as MonitorTarget[];
}

function estimateTargetCredits(target: MonitorTarget): number {
  if (target.type === "scrape") {
    return target.urls.length;
  }

  const limit =
    typeof target.crawlOptions?.limit === "number"
      ? target.crawlOptions.limit
      : 10000;
  return Math.max(1, limit);
}

export function estimateMonitorCreditsPerRun(
  targets: MonitorTarget[],
  judgeEnabled: boolean = false,
): number {
  const scrapeCredits = targets.reduce(
    (sum, target) => sum + estimateTargetCredits(target),
    0,
  );
  return judgeEnabled ? scrapeCredits * 2 : scrapeCredits;
}

function toMonitorSummary(check: MonitorCheckRow): MonitorSummary {
  return {
    totalPages: check.total_pages,
    same: check.same_count,
    changed: check.changed_count,
    new: check.new_count,
    removed: check.removed_count,
    error: check.error_count,
  };
}

function throwIfError(error: any, message: string): void {
  if (error) {
    throw new Error(`${message}: ${error.message ?? JSON.stringify(error)}`);
  }
}

function normalizeGoal(goal: string | undefined | null): string | null {
  if (goal == null) return null;
  const trimmed = goal.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function createMonitor(params: {
  teamId: string;
  input: CreateMonitorRequest;
  nextRunAt: Date;
  intervalMs: number;
}): Promise<MonitorRow> {
  const targets = ensureTargetIds(params.input.targets);
  const judgeEnabled =
    Boolean(params.input.judgeEnabled) &&
    Boolean(normalizeGoal(params.input.goal));
  const estimatedCreditsPerRun = estimateMonitorCreditsPerRun(
    targets,
    judgeEnabled,
  );
  const estimatedCreditsPerMonth =
    estimatedCreditsPerRun * estimateRunsPerMonth(params.intervalMs);

  // Omit goal/judge_enabled keys when undefined so a pre-migration DB
  // doesn't reject the insert. Migration lives in a separate repo.
  const insert: Record<string, unknown> = {
    id: uuidv7(),
    team_id: params.teamId,
    name: params.input.name,
    schedule_cron: params.input.schedule.cron,
    schedule_timezone: params.input.schedule.timezone,
    next_run_at: params.nextRunAt.toISOString(),
    retention_days: params.input.retentionDays,
    estimated_credits_per_month: estimatedCreditsPerMonth,
    targets,
    webhook: params.input.webhook ?? null,
    notification: params.input.notification ?? null,
  };
  if (params.input.goal !== undefined) {
    insert.goal = normalizeGoal(params.input.goal);
  }
  if (params.input.judgeEnabled !== undefined) {
    insert.judge_enabled = params.input.judgeEnabled;
  }
  const { data, error } = await supabase_service
    .from("monitors")
    .insert(insert)
    .select("*")
    .single();

  throwIfError(error, "Failed to create monitor");
  return data as MonitorRow;
}

export async function listMonitors(params: {
  teamId: string;
  limit: number;
  offset: number;
}): Promise<MonitorRow[]> {
  const { data, error } = await supabase_rr_service
    .from("monitors")
    .select("*")
    .eq("team_id", params.teamId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  throwIfError(error, "Failed to list monitors");
  return (data ?? []) as MonitorRow[];
}

export async function getMonitor(
  teamId: string,
  monitorId: string,
): Promise<MonitorRow | null> {
  const { data, error } = await supabase_rr_service
    .from("monitors")
    .select("*")
    .eq("id", monitorId)
    .eq("team_id", teamId)
    .neq("status", "deleted")
    .maybeSingle();

  throwIfError(error, "Failed to get monitor");
  return data as MonitorRow | null;
}

export async function getMonitorForUpdate(
  teamId: string,
  monitorId: string,
): Promise<MonitorRow | null> {
  const { data, error } = await supabase_service
    .from("monitors")
    .select("*")
    .eq("id", monitorId)
    .eq("team_id", teamId)
    .neq("status", "deleted")
    .maybeSingle();

  throwIfError(error, "Failed to get monitor");
  return data as MonitorRow | null;
}

export async function updateMonitor(params: {
  teamId: string;
  monitorId: string;
  input: UpdateMonitorRequest;
  nextRunAt?: Date;
  intervalMs?: number;
}): Promise<MonitorRow | null> {
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (params.input.name !== undefined) patch.name = params.input.name;
  if (params.input.status !== undefined) patch.status = params.input.status;
  if (params.input.webhook !== undefined)
    patch.webhook = params.input.webhook ?? null;
  if (params.input.notification !== undefined) {
    patch.notification = params.input.notification ?? null;
  }
  if (params.input.retentionDays !== undefined) {
    patch.retention_days = params.input.retentionDays;
  }
  if (params.input.goal !== undefined) {
    patch.goal = normalizeGoal(params.input.goal);
  }
  if (params.input.judgeEnabled !== undefined) {
    patch.judge_enabled = params.input.judgeEnabled;
  }
  if (params.input.targets !== undefined) {
    patch.targets = ensureTargetIds(params.input.targets);
  }
  if (params.input.schedule !== undefined) {
    patch.schedule_cron = params.input.schedule.cron;
    patch.schedule_timezone = params.input.schedule.timezone;
    patch.next_run_at = params.nextRunAt?.toISOString() ?? null;
  }

  // Re-estimate whenever any cost input changed. Merge the patch with the
  // current monitor row so a goal/judge-only update still recalculates
  // against the existing targets + schedule, and a targets-only update
  // preserves an already-enabled judge.
  const costInputsChanged =
    params.input.targets !== undefined ||
    params.input.judgeEnabled !== undefined ||
    params.input.goal !== undefined ||
    params.input.schedule !== undefined;
  if (costInputsChanged) {
    const existing = await getMonitorForUpdate(params.teamId, params.monitorId);
    if (existing) {
      const mergedTargets =
        (patch.targets as MonitorTarget[] | undefined) ?? existing.targets;
      const mergedGoal =
        params.input.goal !== undefined
          ? normalizeGoal(params.input.goal)
          : existing.goal;
      const mergedJudgeEnabled =
        params.input.judgeEnabled !== undefined
          ? params.input.judgeEnabled
          : existing.judge_enabled;
      const mergedIntervalMs =
        params.intervalMs ??
        validateMonitorCron(
          (patch.schedule_cron as string | undefined) ?? existing.schedule_cron,
          (patch.schedule_timezone as string | undefined) ??
            existing.schedule_timezone,
        ).intervalMs;
      const judgeOn = Boolean(mergedJudgeEnabled) && Boolean(mergedGoal);
      patch.estimated_credits_per_month =
        estimateMonitorCreditsPerRun(mergedTargets, judgeOn) *
        estimateRunsPerMonth(mergedIntervalMs);
    }
  }

  const { data, error } = await supabase_service
    .from("monitors")
    .update(patch)
    .eq("id", params.monitorId)
    .eq("team_id", params.teamId)
    .neq("status", "deleted")
    .select("*")
    .maybeSingle();

  throwIfError(error, "Failed to update monitor");
  return data as MonitorRow | null;
}

export async function deleteMonitor(params: {
  teamId: string;
  monitorId: string;
}): Promise<boolean> {
  const { data, error } = await supabase_service
    .from("monitors")
    .update({
      status: "deleted",
      deleted_at: new Date().toISOString(),
      next_run_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.monitorId)
    .eq("team_id", params.teamId)
    .neq("status", "deleted")
    .select("id")
    .maybeSingle();

  throwIfError(error, "Failed to delete monitor");
  return !!data;
}

export async function createMonitorCheck(params: {
  monitor: MonitorRow;
  trigger: "scheduled" | "manual";
  scheduledFor?: string | null;
  status?: MonitorCheckRow["status"];
}): Promise<MonitorCheckRow> {
  const estimated = estimateMonitorCreditsPerRun(
    params.monitor.targets,
    Boolean(params.monitor.judge_enabled) && Boolean(params.monitor.goal),
  );
  const { data, error } = await supabase_service
    .from("monitor_checks")
    .insert({
      id: uuidv7(),
      monitor_id: params.monitor.id,
      team_id: params.monitor.team_id,
      trigger: params.trigger,
      status: params.status ?? "queued",
      scheduled_for: params.scheduledFor ?? null,
      estimated_credits: estimated,
    })
    .select("*")
    .single();

  throwIfError(error, "Failed to create monitor check");
  return data as MonitorCheckRow;
}

export async function markMonitorRunning(params: {
  monitorId: string;
  checkId: string;
}): Promise<void> {
  const { error } = await supabase_service
    .from("monitors")
    .update({
      current_check_id: params.checkId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.monitorId)
    .is("current_check_id", null);

  throwIfError(error, "Failed to mark monitor running");
}

export async function dispatchScheduledMonitorCheck(params: {
  monitor: MonitorRow;
  checkId: string;
}): Promise<boolean> {
  const nextRunAt =
    params.monitor.status === "active"
      ? getNextMonitorRunAt(
          params.monitor.schedule_cron,
          new Date(),
          params.monitor.schedule_timezone,
        ).toISOString()
      : null;

  const { data, error } = await supabase_service
    .from("monitors")
    .update({
      current_check_id: params.checkId,
      locked_at: null,
      locked_until: null,
      next_run_at: nextRunAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.monitor.id)
    .is("current_check_id", null)
    .select("id")
    .maybeSingle();

  throwIfError(error, "Failed to dispatch scheduled monitor check");
  return !!data;
}

export async function updateMonitorScheduleAfterRun(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
  summary?: MonitorSummary;
}): Promise<void> {
  const nextRunAt =
    params.monitor.status === "active"
      ? getNextMonitorRunAt(
          params.monitor.schedule_cron,
          new Date(),
          params.monitor.schedule_timezone,
        ).toISOString()
      : null;
  const { error } = await supabase_service
    .from("monitors")
    .update({
      current_check_id: null,
      locked_at: null,
      locked_until: null,
      last_run_at: params.check.finished_at ?? new Date().toISOString(),
      last_check_id: params.check.id,
      next_run_at: nextRunAt,
      last_check_summary: params.summary ?? toMonitorSummary(params.check),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.monitor.id);

  throwIfError(error, "Failed to update monitor after run");
}

export async function advanceMonitorAfterSkippedCheck(params: {
  monitor: MonitorRow;
  check: MonitorCheckRow;
}): Promise<void> {
  const nextRunAt =
    params.monitor.status === "active"
      ? getNextMonitorRunAt(
          params.monitor.schedule_cron,
          new Date(),
          params.monitor.schedule_timezone,
        ).toISOString()
      : null;
  const { error } = await supabase_service
    .from("monitors")
    .update({
      locked_at: null,
      locked_until: null,
      last_run_at: params.check.finished_at ?? new Date().toISOString(),
      last_check_id: params.check.id,
      next_run_at: nextRunAt,
      last_check_summary: toMonitorSummary(params.check),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.monitor.id);

  throwIfError(error, "Failed to advance monitor after skipped check");
}

export async function getMonitorCheck(
  teamId: string,
  monitorId: string,
  checkId: string,
): Promise<MonitorCheckRow | null> {
  const { data, error } = await supabase_rr_service
    .from("monitor_checks")
    .select("*")
    .eq("id", checkId)
    .eq("monitor_id", monitorId)
    .eq("team_id", teamId)
    .maybeSingle();

  throwIfError(error, "Failed to get monitor check");
  return data as MonitorCheckRow | null;
}

export async function listRunningMonitorChecks(
  limit: number = 100,
): Promise<MonitorCheckRow[]> {
  const { data, error } = await supabase_service
    .from("monitor_checks")
    .select("*")
    .eq("status", "running")
    .order("created_at", { ascending: true })
    .limit(limit);

  throwIfError(error, "Failed to list running monitor checks");
  return (data ?? []) as MonitorCheckRow[];
}

export async function listMonitorChecks(params: {
  teamId: string;
  monitorId: string;
  limit: number;
  offset: number;
  status?: MonitorCheckRow["status"];
}): Promise<MonitorCheckRow[]> {
  let query = supabase_rr_service
    .from("monitor_checks")
    .select("*")
    .eq("monitor_id", params.monitorId)
    .eq("team_id", params.teamId)
    .order("created_at", { ascending: false });

  if (params.status) {
    query = query.eq("status", params.status);
  }

  const { data, error } = await query.range(
    params.offset,
    params.offset + params.limit - 1,
  );

  throwIfError(error, "Failed to list monitor checks");
  return (data ?? []) as MonitorCheckRow[];
}

export async function updateMonitorCheck(
  checkId: string,
  patch: Partial<MonitorCheckRow>,
): Promise<MonitorCheckRow> {
  const { data, error } = await supabase_service
    .from("monitor_checks")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq("id", checkId)
    .select("*")
    .single();

  throwIfError(error, "Failed to update monitor check");
  return data as MonitorCheckRow;
}

export async function insertMonitorCheckPages(
  pages: MonitorCheckPageInsert[],
): Promise<void> {
  if (pages.length === 0) return;

  const { error } = await supabase_service.from("monitor_check_pages").insert(
    pages.map(page => ({
      id: uuidv7(),
      ...page,
      url_hash: page.url_hash ?? hashMonitorUrl(page.url),
    })),
  );

  throwIfError(error, "Failed to insert monitor check pages");
}

export async function listMonitorCheckPages(params: {
  teamId: string;
  monitorId: string;
  checkId: string;
  limit: number;
  skip: number;
  status?: string;
}): Promise<any[]> {
  let query = supabase_rr_service
    .from("monitor_check_pages")
    .select("*")
    .eq("check_id", params.checkId)
    .eq("monitor_id", params.monitorId)
    .eq("team_id", params.teamId)
    .order("created_at", { ascending: true });

  if (params.status) {
    query = query.eq("status", params.status);
  }

  const { data, error } = await query.range(
    params.skip,
    params.skip + params.limit - 1,
  );

  throwIfError(error, "Failed to list monitor check pages");
  return data ?? [];
}

export async function countMonitorCheckPages(params: {
  checkId: string;
  targetId?: string;
  status?: string;
}): Promise<number> {
  const pageSize = 1000;
  let total = 0;
  let offset = 0;

  while (true) {
    let query = supabase_rr_service
      .from("monitor_check_pages")
      .select("id")
      .eq("check_id", params.checkId);

    if (params.targetId) {
      query = query.eq("target_id", params.targetId);
    }
    if (params.status) {
      query = query.eq("status", params.status);
    }

    const { data, error } = await query.range(offset, offset + pageSize - 1);
    throwIfError(error, "Failed to count monitor check pages");

    const batch = data ?? [];
    total += batch.length;
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return total;
}

export async function getMonitorPage(params: {
  monitorId: string;
  targetId: string;
  url: string;
}): Promise<MonitorPageRow | null> {
  const { data, error } = await supabase_rr_service
    .from("monitor_pages")
    .select("*")
    .eq("monitor_id", params.monitorId)
    .eq("target_id", params.targetId)
    .eq("url_hash", hashMonitorUrl(params.url))
    .maybeSingle();

  throwIfError(error, "Failed to get monitor page");
  return data as MonitorPageRow | null;
}

export async function upsertMonitorPage(params: {
  monitorId: string;
  teamId: string;
  targetId: string;
  url: string;
  source: "explicit" | "discovered";
  checkId: string;
  scrapeId: string | null;
  status: "same" | "new" | "changed" | "removed" | "error";
  metadata?: unknown;
}): Promise<void> {
  const now = new Date().toISOString();

  const existing = await getMonitorPage({
    monitorId: params.monitorId,
    targetId: params.targetId,
    url: params.url,
  });

  if (!existing) {
    const { error } = await supabase_service.from("monitor_pages").insert({
      monitor_id: params.monitorId,
      team_id: params.teamId,
      target_id: params.targetId,
      url: params.url,
      url_hash: hashMonitorUrl(params.url),
      source: params.source,
      first_seen_check_id: params.checkId,
      last_seen_check_id:
        params.status === "removed" ? undefined : params.checkId,
      last_changed_check_id:
        params.status === "changed" || params.status === "new"
          ? params.checkId
          : undefined,
      last_scrape_id: params.scrapeId,
      last_status: params.status,
      is_removed: params.status === "removed",
      removed_at: params.status === "removed" ? now : null,
      metadata: params.metadata ?? null,
      created_at: now,
      updated_at: now,
    });

    throwIfError(error, "Failed to insert monitor page");
    return;
  }

  const patch: Record<string, unknown> = {
    last_status: params.status,
    is_removed: params.status === "removed",
    removed_at: params.status === "removed" ? now : null,
    metadata: params.metadata ?? existing.metadata ?? null,
    updated_at: now,
  };
  if (params.status !== "removed") {
    patch.last_seen_check_id = params.checkId;
    patch.last_scrape_id = params.scrapeId;
  }
  if (params.status === "changed" || params.status === "new") {
    patch.last_changed_check_id = params.checkId;
  }

  const { error } = await supabase_service
    .from("monitor_pages")
    .update(patch)
    .eq("id", existing.id);

  throwIfError(error, "Failed to update monitor page");
}

export async function listActiveMonitorPages(params: {
  monitorId: string;
  targetId: string;
}): Promise<MonitorPageRow[]> {
  const pageSize = 1000;
  const pages: MonitorPageRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase_rr_service
      .from("monitor_pages")
      .select("*")
      .eq("monitor_id", params.monitorId)
      .eq("target_id", params.targetId)
      .eq("is_removed", false)
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    throwIfError(error, "Failed to list active monitor pages");
    const batch = (data ?? []) as MonitorPageRow[];
    pages.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return pages;
}

export async function claimDueMonitors(params: {
  workerId: string;
  limit: number;
  leaseSeconds: number;
}): Promise<MonitorRow[]> {
  const { data, error } = await supabase_service.rpc(
    "monitoring_claim_due_monitors",
    {
      p_worker_id: params.workerId,
      p_limit: params.limit,
      p_lease_seconds: params.leaseSeconds,
    },
  );

  throwIfError(error, "Failed to claim due monitors");
  return (data ?? []) as MonitorRow[];
}

export async function deferMonitorClaim(
  monitorId: string,
  until: Date,
): Promise<void> {
  const { error } = await supabase_service
    .from("monitors")
    .update({
      locked_until: until.toISOString(),
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", monitorId);

  throwIfError(error, "Failed to defer monitor claim");
}
