import { config } from "../../../config";
import type { BrowserCookie, Meta } from "../context";
import type { EngineScrapeResult } from "../types";

type YouTubeMetadataResponse = {
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

type YouTubeMetadataRequest = {
  url: string;
  transcript_language: string;
  cookies?: BrowserCookie[];
};

function getTranscriptLanguage(meta: Meta): string {
  const requestedLanguage = meta.options.location?.languages?.[0];
  return requestedLanguage?.split(/[-_]/)[0]?.toLowerCase() || "en";
}

function formatValue(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function formatUploadedBy(metadata: YouTubeMetadataResponse): string {
  const name = metadata.uploaded_by?.name ?? "";
  const url = metadata.uploaded_by?.url;

  if (name && url) {
    return `[${name}](${url})`;
  }

  return name || url || "";
}

function isYouTubeVideoPath(url: URL): boolean {
  if (url.pathname === "/watch" && !!url.searchParams.get("v")) {
    return true;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  return pathParts.length === 2 && pathParts[0] === "live";
}

function buildMarkdown(
  metadata: YouTubeMetadataResponse,
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

async function getYouTubeMetadata(
  meta: Meta,
  engineResult: EngineScrapeResult,
): Promise<YouTubeMetadataResponse> {
  const cookies = meta.audioCookies ?? engineResult.audioCookies;
  const requestBody: YouTubeMetadataRequest = {
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
    throw new Error(`YouTube metadata extraction failed: ${error.detail}`);
  }

  const data = (await response
    .json()
    .catch(() => null)) as YouTubeMetadataResponse | null;
  if (
    !data ||
    typeof data.title !== "string" ||
    !data.thumbnail_image ||
    typeof data.thumbnail_image.url !== "string"
  ) {
    throw new Error(
      "YouTube metadata extraction failed: avgrab service returned an invalid response",
    );
  }

  return data;
}

export function shouldRunYoutube(
  url: URL,
  postProcessorsUsed?: string[],
): boolean {
  if (postProcessorsUsed?.includes("youtube")) return false;
  if (url.hostname.endsWith(".youtube.com") || url.hostname === "youtube.com") {
    return isYouTubeVideoPath(url);
  }
  if (url.hostname === "youtu.be") return url.pathname !== "/";
  return false;
}

export async function runYoutube(
  meta: Meta,
  engineResult: EngineScrapeResult,
): Promise<EngineScrapeResult> {
  if (meta.options.lockdown) {
    return engineResult;
  }

  if (!config.AVGRAB_SERVICE_URL) {
    meta.logger.warn("AVGRAB_SERVICE_URL is not configured");
    return engineResult;
  }

  const metadata = await getYouTubeMetadata(meta, engineResult);
  const markdown = buildMarkdown(metadata, engineResult.url);

  return {
    ...engineResult,
    markdown,
    postprocessorsUsed: [...(engineResult.postprocessorsUsed ?? []), "youtube"],
  };
}
