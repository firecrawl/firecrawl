import { config } from "../../../config";
import type { BrowserCookie, Meta } from "..";
import type { Postprocessor } from ".";
import type { EngineScrapeResult } from "../engines";

type VideoMetadataResponse = {
  thumbnail_image: {
    url: string;
    width?: number | null;
    height?: number | null;
  };
  title: string;
  visibility?: string | null;
  uploaded_by?: {
    name?: string | null;
    url?: string | null;
  } | null;
  uploaded_at?: string | null;
  published_at?: string | null;
  length?: string | null;
  views?: number | null;
  likes?: number | null;
  category?: string | null;
  description?: string | null;
  transcript?: string | null;
};

type VideoMetadataRequest = {
  url: string;
  transcript_language: string;
  cookies?: BrowserCookie[];
};

let cachedMetadataUrlRegex: RegExp | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function resetVideoMetadataCacheForTests(): void {
  cachedMetadataUrlRegex = null;
  cacheTimestamp = 0;
}

// Which URLs avgrab can turn into video metadata + transcript is avgrab's
// knowledge, advertised on /supported-urls as metadata_regex — platform
// patterns are not hardcoded here.
async function getMetadataUrlRegex(): Promise<RegExp> {
  if (cachedMetadataUrlRegex && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedMetadataUrlRegex;
  }

  const res = await fetch(`${config.AVGRAB_SERVICE_URL}/supported-urls`);
  if (!res.ok) {
    throw new Error("Failed to fetch supported URL patterns from avgrab");
  }

  const data = await res.json().catch(() => null);
  if (!data || typeof data.metadata_regex !== "string") {
    throw new Error("avgrab returned invalid supported URL patterns");
  }

  try {
    cachedMetadataUrlRegex = new RegExp(data.metadata_regex);
  } catch {
    throw new Error("avgrab returned invalid supported URL patterns");
  }
  cacheTimestamp = Date.now();
  return cachedMetadataUrlRegex;
}

function getTranscriptLanguage(meta: Meta): string {
  const requestedLanguage = meta.options.location?.languages?.[0];
  return requestedLanguage?.split(/[-_]/)[0]?.toLowerCase() || "en";
}

function formatValue(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function formatUploadedBy(metadata: VideoMetadataResponse): string {
  const name = metadata.uploaded_by?.name ?? "";
  const url = metadata.uploaded_by?.url;

  if (name && url) {
    return `[${name}](${url})`;
  }

  return name || url || "";
}

function buildMarkdown(
  metadata: VideoMetadataResponse,
  sourceUrl: string,
): string {
  const thumbnailDimensions =
    metadata.thumbnail_image.width && metadata.thumbnail_image.height
      ? ` (${metadata.thumbnail_image.width}x${metadata.thumbnail_image.height})`
      : "";
  const sections = [
    `![Thumbnail${thumbnailDimensions}](${metadata.thumbnail_image.url})
# [${metadata.title}](${sourceUrl})

**Visibility**: ${formatValue(metadata.visibility)}
**Uploaded by**: ${formatUploadedBy(metadata)}
**Uploaded at**: ${formatValue(metadata.uploaded_at)}
**Published at**: ${formatValue(metadata.published_at)}
**Length**: ${formatValue(metadata.length)}
**Views**: ${formatValue(metadata.views)}
**Likes**: ${formatValue(metadata.likes)}
**Category**: ${formatValue(metadata.category)}`,
    `## Description

\`\`\`
${formatValue(metadata.description)}
\`\`\``,
  ];

  if (metadata.transcript) {
    sections.push(`## Transcript

${metadata.transcript}`);
  }

  return sections.join("\n\n");
}

async function getVideoMetadata(
  meta: Meta,
  engineResult: EngineScrapeResult,
): Promise<VideoMetadataResponse> {
  const cookies = meta.audioCookies ?? engineResult.audioCookies;
  const requestBody: VideoMetadataRequest = {
    url: engineResult.url,
    transcript_language: getTranscriptLanguage(meta),
    ...(cookies && cookies.length > 0 ? { cookies } : {}),
  };

  const response = await fetch(`${config.AVGRAB_SERVICE_URL}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(`Video metadata extraction failed: ${error.detail}`);
  }

  const data = (await response
    .json()
    .catch(() => null)) as VideoMetadataResponse | null;
  if (
    !data ||
    typeof data.title !== "string" ||
    !data.thumbnail_image ||
    typeof data.thumbnail_image.url !== "string"
  ) {
    throw new Error(
      "Video metadata extraction failed: avgrab returned an invalid response",
    );
  }

  return data;
}

export const videoMetadataPostprocessor: Postprocessor = {
  name: "video-metadata",
  // Runs on index cache hits too (the stored raw HTML can't reproduce the
  // transcript/metadata markdown, but avgrab only needs the URL).
  shouldRun: async (meta: Meta, url: URL) => {
    // Lockdown forbids any outbound request touching the target URL, and
    // avgrab fetches the source on our behalf.
    if (meta.options.lockdown) {
      return false;
    }

    if (!config.AVGRAB_SERVICE_URL) {
      return false;
    }

    try {
      const regex = await getMetadataUrlRegex();
      return regex.test(url.href);
    } catch (error) {
      // Enrichment is implicit — an avgrab outage must degrade to a plain
      // scrape, never fail it.
      meta.logger.warn("Failed to check video metadata URL support", {
        error,
      });
      return false;
    }
  },
  run: async (meta: Meta, engineResult: EngineScrapeResult) => {
    const metadata = await getVideoMetadata(meta, engineResult);
    const markdown = buildMarkdown(metadata, engineResult.url);

    return {
      ...engineResult,
      markdown,
      postprocessorsUsed: [
        ...new Set([
          ...(engineResult.postprocessorsUsed ?? []),
          "video-metadata",
        ]),
      ],
    };
  },
};
