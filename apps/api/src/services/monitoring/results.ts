import { NuQJob } from "../worker/nuq";
import { ScrapeJobData } from "../../types";
import { logger as _logger } from "../../lib/logger";
import { createWebhookSender, WebhookEvent } from "../webhook";
import { redisEvictConnection } from "../redis";
import { computeAndPersistPageDiff } from "./diff-orchestrator";
import { derivePageIsMeaningful } from "./page-events";
import {
  deleteMonitorCheckPages,
  getMonitorForUpdate,
  getMonitorPage,
  hashMonitorUrl,
  insertMonitorCheckPages,
  upsertMonitorPage,
} from "./store";

const logger = _logger.child({ module: "monitoring-results" });

// Per-(check, url) webhook claim. checkIds are unique per run, so this only needs
// to outlive a job redelivery; we match runner.ts's notify-claim horizon.
const MONITOR_PAGE_WEBHOOK_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

// Mirror runner.ts's claimMonitorNotification: a redelivered scrape job must not
// re-send the MONITOR_PAGE webhook. Returns true only for the first claimant; a
// redis hiccup degrades to "don't send" rather than throwing out of the caller
// (the page row is already persisted and stays pollable).
function monitorPageNotifyKey(
  checkId: string,
  url: string,
  kind: "page" | "error",
): string {
  return `monitor-page-notify:${checkId}:${hashMonitorUrl(url).toString(
    "hex",
  )}:${kind}`;
}

// Claims the right to send one MONITOR_PAGE webhook for a (check, url). The kind is
// part of the key so a "page" (success/content) notification claims independently and
// can't be suppressed by a prior "error" claim — otherwise a redelivery that flips
// error->success would leave the consumer stuck on a stale error. The reverse is also
// guarded: once a success was sent, an error is skipped so a redelivered failure can't
// regress the consumer back to error. A redis hiccup degrades to "don't send" rather
// than throwing out of the caller (the page row is already persisted and stays pollable).
async function claimMonitorPageWebhook(
  checkId: string,
  url: string,
  kind: "page" | "error",
): Promise<boolean> {
  try {
    if (kind === "error") {
      const pageSent = await redisEvictConnection.exists(
        monitorPageNotifyKey(checkId, url, "page"),
      );
      if (pageSent) return false;
    }
    const result = await redisEvictConnection.set(
      monitorPageNotifyKey(checkId, url, kind),
      "1",
      "EX",
      MONITOR_PAGE_WEBHOOK_CLAIM_TTL_SECONDS,
      "NX",
    );
    return result === "OK";
  } catch (error) {
    logger.warn("Failed to claim monitor page webhook", {
      error,
      checkId,
      url,
    });
    return false;
  }
}

// Idempotently record an error-status check page and (once) notify. Shared by the
// scrape-failure path and the success path's diff/persist guard so a transient
// failure still completes the reconciler's fan-in tally.
async function persistMonitorCheckError(params: {
  monitoring: NonNullable<ScrapeJobData["monitoring"]>;
  teamId: string;
  url: string;
  scrapeId: string;
  error: string;
  statusCode?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await deleteMonitorCheckPages({
    checkId: params.monitoring.checkId,
    targetId: params.monitoring.targetId,
    url: params.url,
  });
  await insertMonitorCheckPages([
    {
      check_id: params.monitoring.checkId,
      monitor_id: params.monitoring.monitorId,
      team_id: params.teamId,
      target_id: params.monitoring.targetId,
      url: params.url,
      status: "error",
      current_scrape_id: params.scrapeId,
      error: params.error,
      status_code: params.statusCode ?? null,
      metadata: params.metadata ?? null,
    },
  ]);

  if (
    await claimMonitorPageWebhook(
      params.monitoring.checkId,
      params.url,
      "error",
    )
  ) {
    await sendMonitorPageWebhook({
      teamId: params.teamId,
      monitorId: params.monitoring.monitorId,
      checkId: params.monitoring.checkId,
      url: params.url,
      status: "error",
      currentScrapeId: params.scrapeId,
      error: params.error,
    });
  }
}

function getDocumentUrl(doc: any, fallback: string): string {
  return doc?.metadata?.sourceURL ?? doc?.metadata?.url ?? doc?.url ?? fallback;
}

function getDocumentStatusCode(doc: any): number | null {
  return typeof doc?.metadata?.statusCode === "number"
    ? doc.metadata.statusCode
    : null;
}

interface PageJudgment {
  meaningful: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  meaningfulChanges: Array<{
    type: "added" | "removed" | "changed";
    before: string | null;
    after: string | null;
    reason: string;
  }>;
}

export async function sendMonitorPageWebhook(params: {
  teamId: string;
  monitorId: string;
  checkId: string;
  url: string;
  status: string;
  previousScrapeId?: string | null;
  currentScrapeId?: string | null;
  error?: string | null;
  judgment?: PageJudgment | null;
  diffText?: string | null;
  diffJson?: Record<string, { previous: unknown; current: unknown }> | null;
}) {
  try {
    const monitor = await getMonitorForUpdate(params.teamId, params.monitorId);
    if (!monitor?.webhook) return;

    const sender = await createWebhookSender({
      teamId: params.teamId,
      jobId: params.checkId,
      webhook: monitor.webhook as any,
      v0: false,
    });

    const isMeaningful = derivePageIsMeaningful(
      params.status,
      params.judgment ?? null,
    );
    const diff =
      params.diffText || params.diffJson
        ? {
            ...(params.diffText ? { text: params.diffText } : {}),
            ...(params.diffJson ? { json: params.diffJson } : {}),
          }
        : null;
    const payload = {
      success: params.status !== "error",
      data: [
        {
          monitorId: params.monitorId,
          checkId: params.checkId,
          url: params.url,
          status: params.status,
          previousScrapeId: params.previousScrapeId ?? null,
          currentScrapeId: params.currentScrapeId ?? null,
          error: params.error ?? null,
          isMeaningful,
          judgment: params.judgment ?? null,
          diff,
        },
      ],
      error: params.error ?? undefined,
    };
    if (sender) {
      await sender.send(WebhookEvent.MONITOR_PAGE, payload);
    }
  } catch (error) {
    logger.warn("Failed to send monitor page webhook", {
      error,
      monitorId: params.monitorId,
      checkId: params.checkId,
      url: params.url,
      status: params.status,
    });
  }
}

export async function recordMonitorScrapeSuccess(
  job: NuQJob<ScrapeJobData>,
  doc: any,
): Promise<void> {
  const monitoring = job.data.monitoring;
  if (!monitoring || job.data.mode !== "single_urls") return;

  const url = getDocumentUrl(doc, job.data.url);
  const previous = await getMonitorPage({
    monitorId: monitoring.monitorId,
    targetId: monitoring.targetId,
    url,
  });

  // The monitor row's target carries the canonical formats; fetch it to
  // decide whether this run is a JSON-extraction monitor.
  const monitorForRun = await getMonitorForUpdate(
    job.data.team_id,
    monitoring.monitorId,
  );
  const targetFormats = monitorForRun?.targets?.find(
    (t: any) => t.id === monitoring.targetId,
  )?.scrapeOptions?.formats;

  const targetCtFormat = Array.isArray(targetFormats)
    ? (targetFormats as any[]).find((f: any) => f?.type === "changeTracking")
    : undefined;
  let diff: Awaited<ReturnType<typeof computeAndPersistPageDiff>>;
  try {
    diff = await computeAndPersistPageDiff({
      teamId: job.data.team_id,
      monitorId: monitoring.monitorId,
      checkId: monitoring.checkId,
      url,
      scrapeId: job.id,
      doc,
      previous: previous
        ? {
            last_scrape_id: previous.last_scrape_id,
            is_removed: previous.is_removed,
          }
        : null,
      formats: targetFormats,
      goal:
        monitorForRun?.judge_enabled && monitorForRun?.goal
          ? monitorForRun.goal
          : null,
      extractionPrompt: targetCtFormat?.prompt ?? null,
    });
  } catch (error) {
    // A transient diff/persist failure (e.g. GCS) must not strand the check:
    // still record an error page so the reconciler's fan-in tally completes
    // instead of hanging until the stale reaper.
    logger.warn("Failed to compute monitor page diff; recording error page", {
      monitorId: monitoring.monitorId,
      checkId: monitoring.checkId,
      targetId: monitoring.targetId,
      scrapeId: job.id,
      url,
      error,
    });
    await persistMonitorCheckError({
      monitoring,
      teamId: job.data.team_id,
      url,
      scrapeId: job.id,
      error: error instanceof Error ? error.message : String(error),
      statusCode: getDocumentStatusCode(doc),
      metadata: { creditsUsed: doc?.metadata?.creditsUsed ?? null },
    });
    return;
  }

  const {
    status,
    diffGcsKey,
    diffTextBytes,
    diffJsonBytes,
    judgment,
    diffText,
    diffJson,
    error,
  } = diff;

  // Tally first (the reconciler's fan-in gate), durable baseline last: a crash
  // between the two completes the check rather than poisoning the cross-run dedup
  // baseline against an unrecorded page. The delete makes redelivery a replace,
  // not a duplicate.
  await deleteMonitorCheckPages({
    checkId: monitoring.checkId,
    targetId: monitoring.targetId,
    url,
  });
  await insertMonitorCheckPages([
    {
      check_id: monitoring.checkId,
      monitor_id: monitoring.monitorId,
      team_id: job.data.team_id,
      target_id: monitoring.targetId,
      url,
      url_hash: hashMonitorUrl(url),
      status,
      previous_scrape_id: previous?.last_scrape_id ?? null,
      current_scrape_id: job.id,
      diff_gcs_key: diffGcsKey,
      diff_text_bytes: diffTextBytes,
      diff_json_bytes: diffJsonBytes,
      status_code: getDocumentStatusCode(doc),
      ...(error ? { error } : {}),
      metadata: {
        title: doc?.metadata?.title ?? null,
        contentType: doc?.metadata?.contentType ?? null,
        numPages: doc?.metadata?.numPages ?? null,
        proxyUsed: doc?.metadata?.proxyUsed ?? null,
        postprocessorsUsed: doc?.metadata?.postprocessorsUsed ?? null,
        creditsUsed: doc?.metadata?.creditsUsed ?? null,
      },
      judgment: judgment ?? null,
    },
  ]);

  await upsertMonitorPage({
    monitorId: monitoring.monitorId,
    teamId: job.data.team_id,
    targetId: monitoring.targetId,
    url,
    source: monitoring.source,
    checkId: monitoring.checkId,
    scrapeId: job.id,
    status,
    metadata: {
      title: doc?.metadata?.title ?? null,
      statusCode: getDocumentStatusCode(doc),
      contentType: doc?.metadata?.contentType ?? null,
      numPages: doc?.metadata?.numPages ?? null,
      proxyUsed: doc?.metadata?.proxyUsed ?? null,
      postprocessorsUsed: doc?.metadata?.postprocessorsUsed ?? null,
      creditsUsed: doc?.metadata?.creditsUsed ?? null,
    },
  });

  logger.info("Recorded monitor scrape result", {
    monitorId: monitoring.monitorId,
    checkId: monitoring.checkId,
    targetId: monitoring.targetId,
    scrapeId: job.id,
    url,
    status,
    previousScrapeId: previous?.last_scrape_id ?? null,
    diffGcsKey,
    judgmentMeaningful: judgment?.meaningful,
  });

  if (await claimMonitorPageWebhook(monitoring.checkId, url, "page")) {
    await sendMonitorPageWebhook({
      teamId: job.data.team_id,
      monitorId: monitoring.monitorId,
      checkId: monitoring.checkId,
      url,
      status,
      previousScrapeId: previous?.last_scrape_id ?? null,
      currentScrapeId: job.id,
      judgment: judgment ?? null,
      diffText: diffText ?? null,
      diffJson: diffJson ?? null,
    });
  }
}

export async function recordMonitorScrapeFailure(
  job: NuQJob<ScrapeJobData>,
  error: unknown,
  creditsUsed?: number | null,
): Promise<void> {
  const monitoring = job.data.monitoring;
  if (!monitoring || job.data.mode !== "single_urls") return;

  await persistMonitorCheckError({
    monitoring,
    teamId: job.data.team_id,
    url: job.data.url,
    scrapeId: job.id,
    error: error instanceof Error ? error.message : String(error),
    metadata: { creditsUsed: creditsUsed ?? null },
  });

  logger.info("Recorded monitor scrape failure", {
    monitorId: monitoring.monitorId,
    checkId: monitoring.checkId,
    targetId: monitoring.targetId,
    scrapeId: job.id,
    url: job.data.url,
    error: error instanceof Error ? error.message : String(error),
  });
}
