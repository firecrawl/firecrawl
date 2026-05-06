import { config } from "../config";
import { storage } from "./gcs-jobs";

type MonitorDiffArtifact = {
  url: string;
  previousScrapeId: string | null;
  currentScrapeId: string | null;
  text: string;
  json: unknown;
  generatedAt: string;
};

const contentType = "application/json";

export function monitorDiffGcsKey(params: {
  teamId: string;
  monitorId: string;
  checkId: string;
  pageId: string;
}): string {
  return `monitors/${params.teamId}/${params.monitorId}/${params.checkId}/${params.pageId}.diff.json`;
}

export async function saveMonitorDiffArtifact(
  key: string,
  artifact: MonitorDiffArtifact,
): Promise<{ textBytes: number; jsonBytes: number }> {
  const payload = JSON.stringify(artifact);
  if (!config.GCS_BUCKET_NAME) {
    return {
      textBytes: Buffer.byteLength(artifact.text),
      jsonBytes: Buffer.byteLength(JSON.stringify(artifact.json ?? null)),
    };
  }

  const bucket = storage.bucket(config.GCS_BUCKET_NAME);
  await bucket.file(key).save(payload, {
    contentType,
    resumable: false,
  });

  return {
    textBytes: Buffer.byteLength(artifact.text),
    jsonBytes: Buffer.byteLength(JSON.stringify(artifact.json ?? null)),
  };
}

export async function getMonitorDiffArtifact(
  key: string | null | undefined,
): Promise<MonitorDiffArtifact | null> {
  if (!key || !config.GCS_BUCKET_NAME) return null;

  const bucket = storage.bucket(config.GCS_BUCKET_NAME);
  try {
    const [contents] = await bucket.file(key).download();
    return JSON.parse(contents.toString()) as MonitorDiffArtifact;
  } catch (error) {
    const maybeGcsError = error as { code?: number; statusCode?: number };
    if (maybeGcsError.code === 404 || maybeGcsError.statusCode === 404) {
      return null;
    }
    throw error;
  }
}
