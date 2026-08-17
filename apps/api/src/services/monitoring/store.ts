import { createHash } from "crypto";
import { v7 as uuidv7 } from "uuid";
import { and, asc, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { monitoringClaimDueMonitors } from "../../db/rpc";
import { shouldParsePDF } from "../../controllers/v2/types";
import {
  getNextMonitorRunAt,
  estimateRunsPerMonth,
  validateMonitorCron,
} from "./cron";
import {
  searchCreditsForResultCount,
  judgeCreditsForJudgedCount,
} from "./search/billing";
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

export function hashMonitorUrl(url: string): Buffer {
  return createHash("sha256").update(url).digest();
}

function ensureTargetIds(targets: Array<Record<string, any>>): MonitorTarget[] {
  return targets.map(target => ({
    ...target,
    id: typeof target.id === "string" ? target.id : uuidv7(),
  })) as MonitorTarget[];
}

const BASE_SCRAPE_CREDITS_PER_PAGE = 1;
const JSON_SCRAPE_CREDITS_PER_PAGE = 5;
const DETERMINISTIC_JSON_SCRAPE_CREDITS_PER_PAGE = 7;
const SCRAPE_OPTION_CREDIT_BONUS = 4;
const JUDGE_CREDITS_PER_PAGE = 1;
const REMOVED_PAGE_CREDITS = 0;
const X_TWITTER_POSTPROCESSOR_CREDIT_BONUS = 29;
const DEFAULT_CRAWL_LIMIT_FOR_ESTIMATE = 10000;
const MONITOR_CHECK_PAGE_BATCH_SIZE = 1000;

type MonitorCreditMetadata = {
  creditsUsed?: unknown;
  numPages?: unknown;
  postprocessorsUsed?: unknown;
};

function formatType(format: unknown): string | null {
  if (typeof format === "string") return format;
  if (
    format &&
    typeof format === "object" &&
    "type" in format &&
    typeof format.type === "string"
  ) {
    return format.type;
  }
  return null;
}

function hasFormatOfType(formats: unknown, type: string): boolean {
  return (
    Array.isArray(formats) &&
    formats.some(format => formatType(format) === type)
  );
}

function hasAnyFormatOfType(formats: unknown, types: string[]): boolean {
  return types.some(type => hasFormatOfType(formats, type));
}

function requestsJsonChangeTracking(formats: unknown): boolean {
  if (!Array.isArray(formats)) return false;
  return formats.some(format => {
    if (
      !format ||
      typeof format !== "object" ||
      !("type" in format) ||
      format.type !== "changeTracking"
    ) {
      return false;
    }
    const modes = "modes" in format ? format.modes : undefined;
    return Array.isArray(modes) && modes.includes("json");
  });
}

function estimateBaseCreditsPerPage(
  options: MonitorTarget["scrapeOptions"],
): number {
  const formats = options?.formats;
  const usesDeterministicJson = hasFormatOfType(formats, "deterministicJson");
  const usesJsonCredits =
    hasFormatOfType(formats, "json") || requestsJsonChangeTracking(formats);
  let credits = BASE_SCRAPE_CREDITS_PER_PAGE;

  if (options?.lockdown) {
    credits += SCRAPE_OPTION_CREDIT_BONUS;
  }

  // Deterministic JSON costs more than plain JSON; both override the base scrape credit.
  if (usesDeterministicJson) {
    credits = DETERMINISTIC_JSON_SCRAPE_CREDITS_PER_PAGE;
  } else if (usesJsonCredits) {
    credits = JSON_SCRAPE_CREDITS_PER_PAGE;
  }

  if (hasAnyFormatOfType(formats, ["question", "query"])) {
    credits += SCRAPE_OPTION_CREDIT_BONUS;
  }

  if (hasFormatOfType(formats, "highlights")) {
    credits += SCRAPE_OPTION_CREDIT_BONUS;
  }

  if (hasFormatOfType(formats, "audio")) {
    credits += SCRAPE_OPTION_CREDIT_BONUS;
  }

  if (hasFormatOfType(formats, "video")) {
    credits += SCRAPE_OPTION_CREDIT_BONUS;
  }

  return credits;
}

function estimateSearchJudgedResults(
  target: Extract<MonitorTarget, { type: "search" }>,
): number {
  return Math.max(1, target.maxResults);
}

function estimateSearchTargetCredits(
  target: Extract<MonitorTarget, { type: "search" }>,
  judgeEnabled: boolean,
): number {
  const rawResults =
    Math.max(1, target.maxResults) * Math.max(1, target.queries.length);
  const searchCallCredits = searchCreditsForResultCount(rawResults, false);
  if (target.depth === "raw" || !judgeEnabled) {
    return searchCallCredits;
  }
  return (
    searchCallCredits +
    judgeCreditsForJudgedCount(estimateSearchJudgedResults(target))
  );
}

function estimateTargetBaseCredits(
  target: MonitorTarget,
  judgeEnabled: boolean = false,
): number {
  const creditsPerPage = estimateBaseCreditsPerPage(target.scrapeOptions);
  if (target.type === "scrape") {
    return target.urls.length * creditsPerPage;
  }
  if (target.type === "search") {
    return estimateSearchTargetCredits(target, judgeEnabled);
  }

  const limit =
    typeof target.crawlOptions?.limit === "number"
      ? target.crawlOptions.limit
      : DEFAULT_CRAWL_LIMIT_FOR_ESTIMATE;
  return Math.max(1, limit) * creditsPerPage;
}

function estimateTargetPageCount(target: MonitorTarget): number {
  if (target.type === "scrape") {
    return target.urls.length;
  }
  if (target.type === "search") {
    return target.maxResults;
  }

  const limit =
    typeof target.crawlOptions?.limit === "number"
      ? target.crawlOptions.limit
      : DEFAULT_CRAWL_LIMIT_FOR_ESTIMATE;
  return Math.max(1, limit);
}

export function estimateMonitorCreditsPerRun(
  targets: MonitorTarget[],
  judgeEnabled: boolean = false,
): number {
  const baseCredits = targets.reduce(
    (sum, target) => sum + estimateTargetBaseCredits(target, judgeEnabled),
    0,
  );
  // Per-page judge allowance is scrape/crawl only; search judging is folded in above.
  const judgeCredits = judgeEnabled
    ? targets.reduce(
        (sum, target) =>
          target.type === "search"
            ? sum
            : sum + estimateTargetPageCount(target) * JUDGE_CREDITS_PER_PAGE,
        0,
      )
    : 0;
  return baseCredits + judgeCredits;
}

export function calculateMonitorCheckActualCreditsFromPages(
  pages: Array<{
    target_id?: string | null;
    metadata?: unknown;
    judgment?: unknown;
    status?: string;
  }>,
  targets: MonitorTarget[] = [],
): number {
  const baseCreditsByTarget = new Map(
    targets.map(target => [
      target.id,
      estimateBaseCreditsPerPage(target.scrapeOptions),
    ]),
  );
  const targetsById = new Map(targets.map(target => [target.id, target]));

  function fallbackBaseCreditsForPage(page: (typeof pages)[number]): number {
    if (page.status === "removed") {
      return REMOVED_PAGE_CREDITS;
    }

    if (page.status === "error") {
      return BASE_SCRAPE_CREDITS_PER_PAGE;
    }

    const metadata = page.metadata as MonitorCreditMetadata | null;
    const target = targetsById.get(page.target_id ?? "");
    let credits =
      baseCreditsByTarget.get(page.target_id ?? "") ??
      BASE_SCRAPE_CREDITS_PER_PAGE;

    // Fallback when metadata.creditsUsed is missing: use retained metadata to avoid
    // undercounting PDFs and special postprocessors.
    if (
      target &&
      shouldParsePDF(target.scrapeOptions?.parsers as any) &&
      typeof metadata?.numPages === "number" &&
      metadata.numPages > 1
    ) {
      credits += metadata.numPages - 1;
    }

    if (
      Array.isArray(metadata?.postprocessorsUsed) &&
      metadata.postprocessorsUsed.includes("x-twitter")
    ) {
      credits += X_TWITTER_POSTPROCESSOR_CREDIT_BONUS;
    }

    return credits;
  }

  function judgeCreditsForPage(page: (typeof pages)[number]): number {
    if (page.judgment == null) {
      return 0;
    }

    // Search is billed at the check level (see flatSearchTargetCredits).
    const target = targetsById.get(page.target_id ?? "");
    if (target?.type === "search") {
      return 0;
    }
    return JUDGE_CREDITS_PER_PAGE;
  }

  return pages.reduce((total, page) => {
    // Search pages carry no per-page credit; billed at check level.
    const target = targetsById.get(page.target_id ?? "");
    if (target?.type === "search") {
      return total;
    }

    const metadata = page.metadata as MonitorCreditMetadata | null;
    const recordedCredits = metadata?.creditsUsed;
    let baseCredits = fallbackBaseCreditsForPage(page);

    if (
      typeof recordedCredits === "number" &&
      Number.isFinite(recordedCredits)
    ) {
      baseCredits = recordedCredits;
    }

    const judgeCredits = judgeCreditsForPage(page);
    return total + baseCredits + judgeCredits;
  }, 0);
}

export function flatSearchTargetCredits(targetResults: unknown): number {
  if (!Array.isArray(targetResults)) return 0;
  return targetResults.reduce((total: number, run: unknown) => {
    if (!run || typeof run !== "object") return total;
    const r = run as {
      type?: unknown;
      searchCredits?: unknown;
      judgeCredits?: unknown;
    };
    if (r.type !== "search") return total;
    const searchCredits =
      typeof r.searchCredits === "number" && Number.isFinite(r.searchCredits)
        ? r.searchCredits
        : 0;
    const judgeCredits =
      typeof r.judgeCredits === "number" && Number.isFinite(r.judgeCredits)
        ? r.judgeCredits
        : 0;
    return total + searchCredits + judgeCredits;
  }, 0);
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

async function run<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(
      `${message}: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
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

  // Omit goal/judge_enabled when undefined so a pre-migration DB doesn't reject the insert.
  const insert: typeof schema.monitors.$inferInsert = {
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
  const [data] = await run(
    () => db.insert(schema.monitors).values(insert).returning(),
    "Failed to create monitor",
  );

  return data as MonitorRow;
}

export async function listMonitors(params: {
  teamId: string;
  limit: number;
  offset: number;
}): Promise<MonitorRow[]> {
  const data = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitors)
        .where(
          and(
            eq(schema.monitors.team_id, params.teamId),
            ne(schema.monitors.status, "deleted"),
          ),
        )
        .orderBy(desc(schema.monitors.created_at))
        .limit(params.limit)
        .offset(params.offset),
    "Failed to list monitors",
  );
  return data as MonitorRow[];
}

export async function getMonitor(
  teamId: string,
  monitorId: string,
): Promise<MonitorRow | null> {
  const [data] = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitors)
        .where(
          and(
            eq(schema.monitors.id, monitorId),
            eq(schema.monitors.team_id, teamId),
            ne(schema.monitors.status, "deleted"),
          ),
        )
        .limit(1),
    "Failed to get monitor",
  );
  return (data ?? null) as MonitorRow | null;
}

export async function getMonitorForUpdate(
  teamId: string,
  monitorId: string,
): Promise<MonitorRow | null> {
  const [data] = await run(
    () =>
      db
        .select()
        .from(schema.monitors)
        .where(
          and(
            eq(schema.monitors.id, monitorId),
            eq(schema.monitors.team_id, teamId),
            ne(schema.monitors.status, "deleted"),
          ),
        )
        .limit(1),
    "Failed to get monitor",
  );
  return (data ?? null) as MonitorRow | null;
}

export async function updateMonitor(params: {
  teamId: string;
  monitorId: string;
  input: UpdateMonitorRequest;
  nextRunAt?: Date;
  intervalMs?: number;
}): Promise<MonitorRow | null> {
  const patch: Partial<typeof schema.monitors.$inferInsert> = {
    updated_at: new Date().toISOString(),
  };

  if (params.input.name !== undefined) patch.name = params.input.name;
  if (params.input.status !== undefined) patch.status = params.input.status;
  if (params.input.webhook !== undefined)
    patch.webhook = params.input.webhook ?? null;
  // Only write when the caller sent config; treat empty {} (legacy default) as
  // "leave unchanged" rather than clobbering stored email settings.
  if (
    params.input.notification !== undefined &&
    params.input.notification !== null &&
    Object.keys(params.input.notification).length > 0
  ) {
    patch.notification = params.input.notification;
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

  // Re-estimate whenever any cost input changed, merging the patch with the current
  // row so partial updates recalculate against existing targets/schedule/judge.
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

  const [data] = await run(
    () =>
      db
        .update(schema.monitors)
        .set(patch)
        .where(
          and(
            eq(schema.monitors.id, params.monitorId),
            eq(schema.monitors.team_id, params.teamId),
            ne(schema.monitors.status, "deleted"),
          ),
        )
        .returning(),
    "Failed to update monitor",
  );
  return (data ?? null) as MonitorRow | null;
}

export async function deleteMonitor(params: {
  teamId: string;
  monitorId: string;
}): Promise<boolean> {
  const data = await run(
    () =>
      db
        .update(schema.monitors)
        .set({
          status: "deleted",
          deleted_at: new Date().toISOString(),
          next_run_at: null,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.monitors.id, params.monitorId),
            eq(schema.monitors.team_id, params.teamId),
            ne(schema.monitors.status, "deleted"),
          ),
        )
        .returning({ id: schema.monitors.id }),
    "Failed to delete monitor",
  );
  return data.length > 0;
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
  const [data] = await run(
    () =>
      db
        .insert(schema.monitor_checks)
        .values({
          id: uuidv7(),
          monitor_id: params.monitor.id,
          team_id: params.monitor.team_id,
          trigger: params.trigger,
          status: params.status ?? "queued",
          scheduled_for: params.scheduledFor ?? null,
          estimated_credits: estimated,
        })
        .returning(),
    "Failed to create monitor check",
  );
  return data as MonitorCheckRow;
}

export async function markMonitorRunning(params: {
  monitorId: string;
  checkId: string;
}): Promise<void> {
  await run(
    () =>
      db
        .update(schema.monitors)
        .set({
          current_check_id: params.checkId,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.monitors.id, params.monitorId),
            isNull(schema.monitors.current_check_id),
          ),
        ),
    "Failed to mark monitor running",
  );
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

  const data = await run(
    () =>
      db
        .update(schema.monitors)
        .set({
          current_check_id: params.checkId,
          locked_at: null,
          locked_until: null,
          next_run_at: nextRunAt,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.monitors.id, params.monitor.id),
            isNull(schema.monitors.current_check_id),
          ),
        )
        .returning({ id: schema.monitors.id }),
    "Failed to dispatch scheduled monitor check",
  );
  return data.length > 0;
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
  await run(
    () =>
      db
        .update(schema.monitors)
        .set({
          current_check_id: null,
          locked_at: null,
          locked_until: null,
          last_run_at: params.check.finished_at ?? new Date().toISOString(),
          last_check_id: params.check.id,
          next_run_at: nextRunAt,
          last_check_summary: params.summary ?? toMonitorSummary(params.check),
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.monitors.id, params.monitor.id)),
    "Failed to update monitor after run",
  );
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
  await run(
    () =>
      db
        .update(schema.monitors)
        .set({
          locked_at: null,
          locked_until: null,
          last_run_at: params.check.finished_at ?? new Date().toISOString(),
          last_check_id: params.check.id,
          next_run_at: nextRunAt,
          last_check_summary: toMonitorSummary(params.check),
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.monitors.id, params.monitor.id)),
    "Failed to advance monitor after skipped check",
  );
}

export async function getMonitorCheck(
  teamId: string,
  monitorId: string,
  checkId: string,
): Promise<MonitorCheckRow | null> {
  const [data] = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_checks)
        .where(
          and(
            eq(schema.monitor_checks.id, checkId),
            eq(schema.monitor_checks.monitor_id, monitorId),
            eq(schema.monitor_checks.team_id, teamId),
          ),
        )
        .limit(1),
    "Failed to get monitor check",
  );
  return (data ?? null) as MonitorCheckRow | null;
}

export async function listRunningMonitorChecks(
  limit: number = 100,
): Promise<MonitorCheckRow[]> {
  const data = await run(
    () =>
      db
        .select()
        .from(schema.monitor_checks)
        .where(eq(schema.monitor_checks.status, "running"))
        .orderBy(asc(schema.monitor_checks.created_at))
        .limit(limit),
    "Failed to list running monitor checks",
  );
  return data as MonitorCheckRow[];
}

export async function listMonitorChecks(params: {
  teamId: string;
  monitorId: string;
  limit: number;
  offset: number;
  status?: MonitorCheckRow["status"];
}): Promise<MonitorCheckRow[]> {
  const conditions = [
    eq(schema.monitor_checks.monitor_id, params.monitorId),
    eq(schema.monitor_checks.team_id, params.teamId),
  ];
  if (params.status) {
    conditions.push(eq(schema.monitor_checks.status, params.status));
  }

  const data = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_checks)
        .where(and(...conditions))
        .orderBy(desc(schema.monitor_checks.created_at))
        .limit(params.limit)
        .offset(params.offset),
    "Failed to list monitor checks",
  );
  return data as MonitorCheckRow[];
}

export async function updateMonitorCheck(
  checkId: string,
  patch: Partial<MonitorCheckRow>,
): Promise<MonitorCheckRow> {
  const [data] = await run(
    () =>
      db
        .update(schema.monitor_checks)
        .set({
          ...patch,
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.monitor_checks.id, checkId))
        .returning(),
    "Failed to update monitor check",
  );
  return data as MonitorCheckRow;
}

// Atomic variant of updateMonitorCheck that only writes while the check is still
// running. A late finalize write that lost the race to the catch path (which marks
// the check failed) becomes a no-op instead of stamping results/searchCompleted onto
// an already-terminal check. Returns the row if it applied, else null.
export async function updateMonitorCheckIfRunning(
  checkId: string,
  patch: Partial<MonitorCheckRow>,
): Promise<MonitorCheckRow | null> {
  const [data] = await run(
    () =>
      db
        .update(schema.monitor_checks)
        .set({
          ...patch,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.monitor_checks.id, checkId),
            eq(schema.monitor_checks.status, "running"),
          ),
        )
        .returning(),
    "Failed to update monitor check",
  );
  return (data as MonitorCheckRow) ?? null;
}

export async function insertMonitorCheckPages(
  pages: MonitorCheckPageInsert[],
): Promise<void> {
  if (pages.length === 0) return;

  await run(
    () =>
      db.insert(schema.monitor_check_pages).values(
        pages.map(page => ({
          id: uuidv7(),
          ...page,
          url_hash: page.url_hash ?? hashMonitorUrl(page.url),
        })),
      ),
    "Failed to insert monitor check pages",
  );
}

// Makes an inline write idempotent: a redelivered check clears its prior rows
// before re-inserting, so crash-and-redeliver can't duplicate pages. Pass `url`
// to scope the clear to a single page so the per-URL scrape path replaces only
// its own row without clobbering sibling pages of the same target. Partition-safe
// (no unique constraint needed).
export async function deleteMonitorCheckPages(params: {
  checkId: string;
  targetId: string;
  url?: string;
}): Promise<void> {
  const conditions = [
    eq(schema.monitor_check_pages.check_id, params.checkId),
    eq(schema.monitor_check_pages.target_id, params.targetId),
  ];
  if (params.url !== undefined) {
    conditions.push(
      eq(schema.monitor_check_pages.url_hash, hashMonitorUrl(params.url)),
    );
  }
  await run(
    () => db.delete(schema.monitor_check_pages).where(and(...conditions)),
    "Failed to delete monitor check pages",
  );
}

export async function listMonitorCheckPages(params: {
  teamId: string;
  monitorId: string;
  checkId: string;
  limit: number;
  skip: number;
  status?: string;
}): Promise<any[]> {
  const conditions = [
    eq(schema.monitor_check_pages.check_id, params.checkId),
    eq(schema.monitor_check_pages.monitor_id, params.monitorId),
    eq(schema.monitor_check_pages.team_id, params.teamId),
  ];
  if (params.status) {
    conditions.push(eq(schema.monitor_check_pages.status, params.status));
  }

  const data = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_check_pages)
        .where(and(...conditions))
        .orderBy(asc(schema.monitor_check_pages.created_at))
        .limit(params.limit)
        .offset(params.skip),
    "Failed to list monitor check pages",
  );
  return data;
}

export async function countMonitorCheckPages(params: {
  checkId: string;
  targetId?: string;
  status?: string;
}): Promise<number> {
  const conditions = [eq(schema.monitor_check_pages.check_id, params.checkId)];
  if (params.targetId) {
    conditions.push(eq(schema.monitor_check_pages.target_id, params.targetId));
  }
  if (params.status) {
    conditions.push(eq(schema.monitor_check_pages.status, params.status));
  }

  const [row] = await run(
    () =>
      dbRr
        .select({ value: count() })
        .from(schema.monitor_check_pages)
        .where(and(...conditions)),
    "Failed to count monitor check pages",
  );

  return row?.value ?? 0;
}

export async function calculateMonitorCheckActualCredits(params: {
  checkId: string;
  targets: MonitorTarget[];
  targetResults?: unknown;
}): Promise<number> {
  let total = flatSearchTargetCredits(params.targetResults);
  let offset = 0;

  while (true) {
    const batch = await run(
      () =>
        dbRr
          .select({
            target_id: schema.monitor_check_pages.target_id,
            metadata: schema.monitor_check_pages.metadata,
            judgment: schema.monitor_check_pages.judgment,
            status: schema.monitor_check_pages.status,
          })
          .from(schema.monitor_check_pages)
          .where(eq(schema.monitor_check_pages.check_id, params.checkId))
          .orderBy(asc(schema.monitor_check_pages.id))
          .limit(MONITOR_CHECK_PAGE_BATCH_SIZE)
          .offset(offset),
      "Failed to calculate monitor check credits",
    );

    total += calculateMonitorCheckActualCreditsFromPages(batch, params.targets);

    if (batch.length < MONITOR_CHECK_PAGE_BATCH_SIZE) break;
    offset += MONITOR_CHECK_PAGE_BATCH_SIZE;
  }

  return total;
}

export async function getMonitorPage(params: {
  monitorId: string;
  targetId: string;
  url: string;
}): Promise<MonitorPageRow | null> {
  const [data] = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_pages)
        .where(
          and(
            eq(schema.monitor_pages.monitor_id, params.monitorId),
            eq(schema.monitor_pages.target_id, params.targetId),
            eq(schema.monitor_pages.url_hash, hashMonitorUrl(params.url)),
          ),
        )
        .limit(1),
    "Failed to get monitor page",
  );
  return (data ?? null) as MonitorPageRow | null;
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
  // When the caller's finalize times out it aborts this signal; we then skip the
  // write so an orphaned baseline can't poison the next run's dedup state.
  abortSignal?: AbortSignal;
}): Promise<void> {
  const now = new Date().toISOString();

  const existing = await getMonitorPage({
    monitorId: params.monitorId,
    targetId: params.targetId,
    url: params.url,
  });

  if (params.abortSignal?.aborted) return;

  if (!existing) {
    await run(
      () =>
        db.insert(schema.monitor_pages).values({
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
        }),
      "Failed to insert monitor page",
    );
    return;
  }

  const patch: Partial<typeof schema.monitor_pages.$inferInsert> = {
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

  await run(
    () =>
      db
        .update(schema.monitor_pages)
        .set(patch)
        .where(eq(schema.monitor_pages.id, existing.id)),
    "Failed to update monitor page",
  );
}

type BulkUpsertMonitorPageRow = {
  url: string;
  urlHash?: Buffer;
  status: "same" | "new" | "changed" | "removed" | "error";
  metadata?: unknown;
  source: "explicit" | "discovered";
  scrapeId: string | null;
};

// Bulk equivalent of upsertMonitorPage: collapses an N-page upsert from ~2N
// sequential round-trips (replica read + primary write per page) into ONE atomic
// INSERT ... ON CONFLICT DO UPDATE keyed by the (monitor_id, target_id, url_hash)
// unique index. Per-row field rules mirror upsertMonitorPage exactly, expressed in
// the conflict set via `excluded` + CASE so no read is needed and Drizzle handles
// the enum/jsonb column types (no hand-written casts that can drift from the schema).
export async function bulkUpsertMonitorPages(params: {
  monitorId: string;
  teamId: string;
  targetId: string;
  checkId: string;
  rows: BulkUpsertMonitorPageRow[];
  // When finalize times out the caller aborts this signal; we then skip the whole
  // write so an aborted finalize leaves monitor_pages untouched (no partial baseline).
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (params.abortSignal?.aborted) return;

  // Dedup by url_hash (last wins) so a repeated URL can't double-insert, and sort
  // by url_hash for a deterministic row-lock order.
  const byHash = new Map<
    string,
    BulkUpsertMonitorPageRow & { urlHash: Buffer }
  >();
  for (const row of params.rows) {
    const urlHash = row.urlHash ?? hashMonitorUrl(row.url);
    byHash.set(urlHash.toString("hex"), { ...row, urlHash });
  }
  if (byHash.size === 0) return;
  const rows = [...byHash.values()].sort((a, b) =>
    a.urlHash.toString("hex") < b.urlHash.toString("hex") ? -1 : 1,
  );

  const now = new Date().toISOString();

  // Build every row as if newly inserted; ON CONFLICT applies the existing-row
  // rules via `excluded` + CASE so the whole upsert is ONE atomic statement — no
  // separate read, no separate update — and Drizzle maps the enum/jsonb types from
  // the schema, so there are no hand-written casts that can drift from the columns.
  const values = rows.map(row => {
    const isRemoved = row.status === "removed";
    const isChangedOrNew = row.status === "changed" || row.status === "new";
    return {
      monitor_id: params.monitorId,
      team_id: params.teamId,
      target_id: params.targetId,
      url: row.url,
      url_hash: row.urlHash,
      source: row.source,
      first_seen_check_id: params.checkId,
      last_seen_check_id: isRemoved ? null : params.checkId,
      last_changed_check_id: isChangedOrNew ? params.checkId : null,
      last_scrape_id: row.scrapeId,
      last_status: row.status,
      is_removed: isRemoved,
      removed_at: isRemoved ? now : null,
      metadata: row.metadata ?? null,
      created_at: now,
      updated_at: now,
    };
  });

  if (params.abortSignal?.aborted) return;

  await run(
    () =>
      db
        .insert(schema.monitor_pages)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.monitor_pages.monitor_id,
            schema.monitor_pages.target_id,
            schema.monitor_pages.url_hash,
          ],
          set: {
            last_status: sql`excluded.last_status`,
            is_removed: sql`excluded.is_removed`,
            removed_at: sql`excluded.removed_at`,
            // Preserve prior metadata when the new row carries none.
            metadata: sql`coalesce(excluded.metadata, ${schema.monitor_pages.metadata})`,
            // last_seen / last_scrape advance only when not removed; else preserved.
            last_seen_check_id: sql`case when excluded.is_removed then ${schema.monitor_pages.last_seen_check_id} else excluded.last_seen_check_id end`,
            last_scrape_id: sql`case when excluded.is_removed then ${schema.monitor_pages.last_scrape_id} else excluded.last_scrape_id end`,
            // last_changed advances only on new/changed; first_seen is never touched.
            last_changed_check_id: sql`case when excluded.last_status in ('new','changed') then excluded.last_changed_check_id else ${schema.monitor_pages.last_changed_check_id} end`,
            updated_at: sql`excluded.updated_at`,
          },
        }),
    "Failed to bulk upsert monitor pages",
  );
}

export async function listActiveMonitorPages(params: {
  monitorId: string;
  targetId: string;
}): Promise<MonitorPageRow[]> {
  const data = await run(
    () =>
      dbRr
        .select()
        .from(schema.monitor_pages)
        .where(
          and(
            eq(schema.monitor_pages.monitor_id, params.monitorId),
            eq(schema.monitor_pages.target_id, params.targetId),
            eq(schema.monitor_pages.is_removed, false),
          ),
        )
        .orderBy(asc(schema.monitor_pages.created_at)),
    "Failed to list active monitor pages",
  );
  return data as MonitorPageRow[];
}

export async function claimDueMonitors(params: {
  workerId: string;
  limit: number;
  leaseSeconds: number;
}): Promise<MonitorRow[]> {
  const data = await run(
    () => monitoringClaimDueMonitors<MonitorRow>(params),
    "Failed to claim due monitors",
  );
  return data;
}

export async function deferMonitorClaim(
  monitorId: string,
  until: Date,
): Promise<void> {
  await run(
    () =>
      db
        .update(schema.monitors)
        .set({
          locked_until: until.toISOString(),
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.monitors.id, monitorId)),
    "Failed to defer monitor claim",
  );
}
