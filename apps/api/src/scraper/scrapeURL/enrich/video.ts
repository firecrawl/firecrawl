import { Meta } from "..";
import { Document, VideoItem } from "../../../controllers/v2/types";
import { config } from "../../../config";
import { hasFormatOfType } from "../../../lib/format-utils";

let cachedUrlRegex: RegExp | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function resetVideoTransformerCacheForTests() {
  cachedUrlRegex = null;
  cacheTimestamp = 0;
}

async function getSupportedUrlRegex(): Promise<RegExp> {
  if (cachedUrlRegex && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedUrlRegex;
  }

  const res = await fetch(`${config.AVGRAB_SERVICE_URL}/supported-urls`);
  if (!res.ok) {
    throw new Error(
      "Failed to fetch supported URL patterns from video service",
    );
  }

  const data = await res.json().catch(() => null);
  if (!data || typeof data.regex !== "string") {
    throw new Error("Video service returned invalid supported URL patterns");
  }

  try {
    cachedUrlRegex = new RegExp(data.regex);
  } catch {
    throw new Error("Video service returned invalid supported URL patterns");
  }
  cacheTimestamp = Date.now();
  return cachedUrlRegex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeVideoItem(value: unknown): VideoItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = optionalString(value.url);
  const sourceURL = optionalString(value.sourceURL);
  const source = optionalString(value.source);
  if (!url || !sourceURL || !source) {
    return null;
  }

  return {
    url,
    sourceURL,
    source,
    kind: optionalString(value.kind),
    provider: optionalString(value.provider),
    title: optionalString(value.title),
    thumbnail: optionalString(value.thumbnail),
    description: optionalString(value.description),
    duration: optionalString(value.duration),
    mimeType: optionalString(value.mimeType),
    width: optionalNumber(value.width),
    height: optionalNumber(value.height),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

async function fetchGenericVideos(
  meta: Meta,
  document: Document,
): Promise<VideoItem[]> {
  const requestBody = {
    url: meta.rewrittenUrl ?? meta.url,
    ...(document.rawHtml || document.html
      ? { html: document.rawHtml ?? document.html }
      : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${config.AVGRAB_SERVICE_URL}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    meta.logger.warn("Generic video discovery failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  if (response.status === 404) {
    meta.logger.debug("avgrab /videos endpoint is unavailable");
    return [];
  }

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    meta.logger.warn("Generic video discovery failed", {
      detail: isRecord(error) ? error.detail : undefined,
    });
    return [];
  }

  const data = await response.json().catch(() => null);
  if (!isRecord(data) || !Array.isArray(data.videos)) {
    meta.logger.warn("Generic video discovery returned an invalid response");
    return [];
  }

  return data.videos.flatMap(item => {
    const normalized = normalizeVideoItem(item);
    return normalized ? [normalized] : [];
  });
}

function shouldTryLegacyDownload(videos: VideoItem[]): boolean {
  return !videos.some(
    video => video.kind !== "page" || video.source !== "provider",
  );
}

function isYouTubeURL(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be"
    );
  } catch {
    return false;
  }
}

async function fetchLegacyVideoIfSupported(meta: Meta, document: Document) {
  const urlRegex = await getSupportedUrlRegex();

  if (!urlRegex.test(meta.url)) {
    return;
  }

  const requestBody = {
    url: meta.url,
    ...(meta.audioCookies && meta.audioCookies.length > 0
      ? { cookies: meta.audioCookies }
      : {}),
  };

  const response = await fetch(`${config.AVGRAB_SERVICE_URL}/download-video`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(`Video download failed: ${error.detail}`);
  }

  const data = await response.json().catch(() => null);

  if (!data || !data.public_url || typeof data.public_url !== "string") {
    throw new Error(
      "Video download failed: avgrab service returned an invalid response (missing public_url)",
    );
  }

  document.video = data.public_url;
}

export async function fetchVideo(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!hasFormatOfType(meta.options.formats, "video")) {
    return document;
  }

  // Lockdown forbids outbound requests that touch the target URL. avgrab
  // fetches the source on our behalf, so skip it here.
  if (meta.options.lockdown) {
    return document;
  }

  if (!config.AVGRAB_SERVICE_URL) {
    meta.logger.warn("AVGRAB_SERVICE_URL is not configured");
    document.warning =
      "Video format is not available (service not configured)." +
      (document.warning ? " " + document.warning : "");
    return document;
  }

  if (isYouTubeURL(meta.url)) {
    await fetchLegacyVideoIfSupported(meta, document);
    return document;
  }

  const videos = await fetchGenericVideos(meta, document);
  if (videos.length > 0) {
    document.videos = videos;
  }

  if (!shouldTryLegacyDownload(videos)) {
    return document;
  }

  try {
    await fetchLegacyVideoIfSupported(meta, document);
  } catch (error) {
    if (videos.length > 0) {
      meta.logger.warn("Skipping legacy video download", { error });
      return document;
    }
    throw error;
  }

  return document;
}
