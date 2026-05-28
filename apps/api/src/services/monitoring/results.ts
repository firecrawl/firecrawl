import { NuQJob } from "../worker/nuq";
import { ScrapeJobData } from "../../types";
import { logger as _logger } from "../../lib/logger";
import { createWebhookSender, WebhookEvent } from "../webhook";
import { billTeam } from "../billing/credit_billing";
import { computeAndPersistPageDiff } from "./diff-orchestrator";
import { derivePageIsMeaningful } from "./page-events";
import {
  getMonitorForUpdate,
  getMonitorPage,
  hashMonitorUrl,
  insertMonitorCheckPages,
  upsertMonitorPage,
} from "./store";

const JUDGE_CREDIT_COST = 1;

const logger = _logger.child({ module: "monitoring-results" });

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

async function sendMonitorPageWebhook(params: {
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
  const {
    status,
    diffGcsKey,
    diffTextBytes,
    diffJsonBytes,
    judgment,
    diffText,
    diffJson,
  } = await computeAndPersistPageDiff({
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
      creditsUsed: doc?.metadata?.creditsUsed ?? null,
    },
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
      metadata: {
        title: doc?.metadata?.title ?? null,
        creditsUsed: doc?.metadata?.creditsUsed ?? null,
      },
      judgment: judgment ?? null,
    },
  ]);

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

  if (judgment) {
    try {
      await billTeam(
        job.data.team_id,
        undefined,
        JUDGE_CREDIT_COST,
        job.data.apiKeyId ?? null,
        { endpoint: "monitor", jobId: monitoring.checkId },
        logger,
      );
    } catch (error) {
      logger.warn("Failed to bill judge credit", {
        error,
        monitorId: monitoring.monitorId,
        checkId: monitoring.checkId,
      });
    }
  }

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

export async function recordMonitorScrapeFailure(
  job: NuQJob<ScrapeJobData>,
  error: unknown,
): Promise<void> {
  const monitoring = job.data.monitoring;
  if (!monitoring || job.data.mode !== "single_urls") return;

  await insertMonitorCheckPages([
    {
      check_id: monitoring.checkId,
      monitor_id: monitoring.monitorId,
      team_id: job.data.team_id,
      target_id: monitoring.targetId,
      url: job.data.url,
      url_hash: hashMonitorUrl(job.data.url),
      status: "error",
      current_scrape_id: job.id,
      error: error instanceof Error ? error.message : String(error),
    },
  ]);

  logger.info("Recorded monitor scrape failure", {
    monitorId: monitoring.monitorId,
    checkId: monitoring.checkId,
    targetId: monitoring.targetId,
    scrapeId: job.id,
    url: job.data.url,
    error: error instanceof Error ? error.message : String(error),
  });

  await sendMonitorPageWebhook({
    teamId: job.data.team_id,
    monitorId: monitoring.monitorId,
    checkId: monitoring.checkId,
    url: job.data.url,
    status: "error",
    currentScrapeId: job.id,
    error: error instanceof Error ? error.message : String(error),
  });
}
