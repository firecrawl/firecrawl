import { v7 as uuidv7 } from "uuid";
import { NuQJob } from "../worker/nuq";
import { ScrapeJobData } from "../../types";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import {
  monitorDiffGcsKey,
  saveMonitorDiffArtifact,
} from "../../lib/gcs-monitoring";
import { diffMonitorMarkdown } from "./diff";
import {
  getMonitorPage,
  hashMonitorUrl,
  insertMonitorCheckPages,
  upsertMonitorPage,
} from "./store";

function getDocumentUrl(doc: any, fallback: string): string {
  return doc?.metadata?.sourceURL ?? doc?.metadata?.url ?? doc?.url ?? fallback;
}

function getDocumentStatusCode(doc: any): number | null {
  return typeof doc?.metadata?.statusCode === "number"
    ? doc.metadata.statusCode
    : null;
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

  let status: "same" | "new" | "changed" = "new";
  let diffGcsKey: string | null = null;
  let diffTextBytes: number | null = null;
  let diffJsonBytes: number | null = null;

  if (previous?.last_scrape_id && !previous.is_removed) {
    const previousDoc = (await getJobFromGCS(previous.last_scrape_id))?.[0];
    const previousMarkdown = previousDoc?.markdown;
    const currentMarkdown = doc?.markdown;

    if (previousMarkdown && currentMarkdown) {
      const diff = diffMonitorMarkdown(previousMarkdown, currentMarkdown);
      status = diff.status;

      if (diff.status === "changed") {
        diffGcsKey = monitorDiffGcsKey({
          teamId: job.data.team_id,
          monitorId: monitoring.monitorId,
          checkId: monitoring.checkId,
          pageId: uuidv7(),
        });
        const sizes = await saveMonitorDiffArtifact(diffGcsKey, {
          url,
          previousScrapeId: previous.last_scrape_id,
          currentScrapeId: job.id,
          text: diff.text,
          json: diff.json,
          generatedAt: new Date().toISOString(),
        });
        diffTextBytes = sizes.textBytes;
        diffJsonBytes = sizes.jsonBytes;
      }
    } else {
      status = "changed";
    }
  }

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
    },
  ]);
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
}
