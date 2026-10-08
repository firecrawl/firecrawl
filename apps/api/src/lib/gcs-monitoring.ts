import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import { config } from "../config";
import { storage } from "./gcs-jobs";
import { logger } from "./logger";

type MonitorDiffArtifactBase = {
  url: string;
  previousScrapeId: string | null;
  currentScrapeId: string | null;
  generatedAt: string;
};

export type MonitorDiffArtifact =
  | (MonitorDiffArtifactBase & {
      kind: "markdown";
      text: string;
      json: unknown;
    })
  | (MonitorDiffArtifactBase & {
      kind: "json";
      /** Per-field {previous, current} diff. */
      json: Record<string, { previous: unknown; current: unknown }>;
      /** Full current JSON extraction (the snapshot at this run). */
      snapshot: Record<string, unknown>;
      /**
       * Optional markdown diff sidecar. Populated only when the monitor's
       * formats requested both `"json"` and `"git-diff"` change-tracking
       * modes — in that case we run both diffs and report `changed` if
       * either path saw a change.
       */
      markdown?: {
        text: string;
        json: unknown;
      };
    });

const contentType = "application/json";
const BACKOFF_PARAMS = [0, 250, 1000];

const credentials = config.GCS_CREDENTIALS
  ? JSON.parse(atob(config.GCS_CREDENTIALS))
  : undefined;

const storageManualRetries = new Storage({
  credentials,
  retryOptions: {
    autoRetry: false,
    maxRetries: 0,
  },
});

type GCSOperationAttempt = {
  error: any;
  timeMs: number;
  backoffMs: number;
};

export function monitorDiffGcsKey(params: {
  teamId: string;
  monitorId: string;
  checkId: string;
  pageId: string;
}): string {
  const id = [
    params.teamId,
    params.monitorId,
    params.checkId,
    params.pageId,
  ].join("-");
  return `monitors/diffs/v2/${monitorDiffIdToFilename(id)}`;
}

function monitorDiffIdToFilename(id: string): string {
  // Match the gcs-jobs filename pattern: put the random-looking hash before
  // the stable identifier so writes spread across GCS object-name key ranges.
  return `${crypto.createHash("sha256").update(id).digest("hex")}-${id}.json`;
}

function artifactBytes(artifact: MonitorDiffArtifact): {
  textBytes: number;
  jsonBytes: number;
} {
  const jsonBytes = Buffer.byteLength(JSON.stringify(artifact.json ?? null));
  let textBytes = 0;
  if (artifact.kind === "markdown") {
    textBytes = Buffer.byteLength(artifact.text);
  } else if (artifact.kind === "json" && artifact.markdown) {
    // Sidecar markdown diff (mixed-mode monitor) — count it so storage
    // accounting stays honest.
    textBytes = Buffer.byteLength(artifact.markdown.text);
  }
  return { textBytes, jsonBytes };
}

export async function saveMonitorDiffArtifact(
  key: string,
  artifact: MonitorDiffArtifact,
): Promise<{ textBytes: number; jsonBytes: number }> {
  const payload = JSON.stringify(artifact);
  if (!config.GCS_BUCKET_NAME) {
    return artifactBytes(artifact);
  }

  const saveAttempts: GCSOperationAttempt[] = [];
  const bucket = storageManualRetries.bucket(config.GCS_BUCKET_NAME);
  const blob = bucket.file(key);

  return await (async () => {
    for (let i = 0; i < BACKOFF_PARAMS.length; i++) {
      const backoffMs = BACKOFF_PARAMS[i];
      if (backoffMs > 0) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }

      const saveStart = Date.now();
      try {
        await blob.save(payload, {
          contentType,
          resumable: false,
        });
        saveAttempts.push({
          error: null,
          timeMs: Date.now() - saveStart,
          backoffMs,
        });
        break;
      } catch (error) {
        // TODO: determine what kind of errors we should backoff or instafail on
        saveAttempts.push({
          error,
          timeMs: Date.now() - saveStart,
          backoffMs,
        });

        if (i === BACKOFF_PARAMS.length - 1) {
          throw error;
        }
      }
    }

    return artifactBytes(artifact);
  })()
    .then(result => {
      if (saveAttempts.length === 1) {
        logger.debug("Monitor diff artifact saved to GCS", {
          canonicalLog: "gcs-monitoring/save",
          key,
          saveAttempts,
          success: true,
        });
      } else {
        logger.warn("Monitor diff artifact saved to GCS with retries", {
          canonicalLog: "gcs-monitoring/save",
          key,
          saveAttempts,
          success: true,
        });
      }
      return result;
    })
    .catch(error => {
      logger.error("Monitor diff artifact save to GCS failed", {
        canonicalLog: "gcs-monitoring/save",
        key,
        saveAttempts,
        success: false,
        error,
      });
      throw error;
    });
}

export async function getMonitorDiffArtifact(
  key: string | null | undefined,
): Promise<MonitorDiffArtifact | null> {
  if (!key || !config.GCS_BUCKET_NAME) return null;

  const bucket = storage.bucket(config.GCS_BUCKET_NAME);
  try {
    const [contents] = await bucket.file(key).download();
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString());
    } catch {
      // Corrupt or truncated artifact — surface as "no diff" instead of
      // letting JSON.parse throw and break the entire check response.
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // An unexpected payload shape (e.g. number, array, null) was written
      // here; treat as missing rather than risk reading kind off a non-object.
      return null;
    }
    const asPartial = parsed as Partial<MonitorDiffArtifact>;
    // Backwards compat: historical artifacts predate the `kind` field and
    // are always markdown.
    if (!asPartial.kind) {
      return { ...(asPartial as any), kind: "markdown" } as MonitorDiffArtifact;
    }
    return asPartial as MonitorDiffArtifact;
  } catch (error) {
    const maybeGcsError = error as { code?: number; statusCode?: number };
    if (maybeGcsError.code === 404 || maybeGcsError.statusCode === 404) {
      return null;
    }
    throw error;
  }
}
