import type { Meta } from "..";
import type { Postprocessor } from ".";
import type { EngineScrapeResult } from "../engines";

export const youtubePostprocessor: Postprocessor = {
  name: "youtube",
  shouldRun: (_meta: Meta, url: URL, postProcessorsUsed?: string[]) => {
    if (postProcessorsUsed?.includes("youtube")) {
      return false;
    }

    if (
      url.hostname.endsWith(".youtube.com") ||
      url.hostname === "youtube.com"
    ) {
      return url.pathname === "/watch" && !!url.searchParams.get("v");
    } else if (url.hostname === "youtu.be") {
      return url.pathname !== "/";
    } else {
      return false;
    }
  },
  run: async (meta: Meta, engineResult: EngineScrapeResult) => {
    let initialData;
    try {
      initialData = JSON.parse(
        engineResult.html
          .split("var ytInitialPlayerResponse = ")[1]
          .split(";var meta =")[0],
      );
    } catch (e) {
      meta.logger.warn("Failed to parse YouTube initial data");
      return engineResult;
    }

    const largestThumbnail =
      initialData.videoDetails.thumbnail.thumbnails.slice(-1)[0];
    const lengthSeconds = parseFloat(initialData.videoDetails.lengthSeconds);
    const lengthTrueSeconds = lengthSeconds % 60;
    const lengthMinutes = Math.floor(lengthSeconds / 60) % 60;
    const lengthHours = Math.floor(lengthSeconds / 3600);

    const endscreen = (
      initialData.endscreen?.endscreenRenderer?.elements || []
    ).filter(x => x.endscreenElementRenderer?.style === "VIDEO");

    let transcriptMarkdown = "";
    let transcriptText: string | undefined;

    if (engineResult.youtubeTranscriptContent) {
      const initialSegments =
        engineResult.youtubeTranscriptContent?.actions?.[0]
          ?.updateEngagementPanelAction?.content?.transcriptRenderer?.content
          ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer
          ?.initialSegments ?? [];
      transcriptText = (Array.isArray(initialSegments) ? initialSegments : [])
        .map(x => x?.transcriptSegmentRenderer?.snippet?.runs?.[0]?.text)
        .filter(Boolean)
        .join(" ");
      transcriptMarkdown = `## Transcript

${transcriptText}
`;
    }

    const endscreenLinks = endscreen
      .map(element => {
        const renderer = element.endscreenElementRenderer;
        if (!renderer) {
          return undefined;
        }

        const title =
          renderer.title?.simpleText ??
          renderer.title?.runs?.map(run => run.text).join("");
        const urlPath =
          renderer.endpoint?.commandMetadata?.webCommandMetadata?.url;

        if (!title || !urlPath) {
          return undefined;
        }

        const thumbnail = renderer.thumbnail?.thumbnails?.slice(-1)?.[0];

        return {
          title,
          url: new URL(urlPath, engineResult.url).toString(),
          ...(thumbnail
            ? {
                thumbnail: {
                  url: thumbnail.url,
                  width: thumbnail.width,
                  height: thumbnail.height,
                },
              }
            : {}),
        };
      })
      .filter(
        (
          value,
        ): value is {
          title: string;
          url: string;
          thumbnail?: { url: string; width: number; height: number };
        } => value !== undefined,
      );

    const visibility = initialData.videoDetails.isPrivate
      ? "Private"
      : initialData.microformat.playerMicroformatRenderer.isUnlisted
        ? "Unlisted"
        : "Public";

    const formattedLength = `${
      lengthHours > 0 ? `${lengthHours.toString().padStart(2, "0")}:` : ""
    }${lengthMinutes.toString().padStart(2, "0")}:${lengthTrueSeconds
      .toString()
      .padStart(2, "0")}`;

    const json = {
      title: initialData.videoDetails.title,
      url: initialData.microformat.playerMicroformatRenderer.canonicalUrl,
      visibility,
      channel: {
        name: initialData.videoDetails.author,
        url: initialData.microformat.playerMicroformatRenderer.ownerProfileUrl,
      },
      uploadedAt: initialData.microformat.playerMicroformatRenderer.uploadDate,
      publishedAt:
        initialData.microformat.playerMicroformatRenderer.publishDate,
      duration: {
        seconds: lengthSeconds,
        formatted: formattedLength,
      },
      stats: {
        views: initialData.videoDetails.viewCount,
        likes: initialData.microformat.playerMicroformatRenderer.likeCount,
      },
      category: initialData.microformat.playerMicroformatRenderer.category,
      description: initialData.videoDetails.shortDescription,
      thumbnail: {
        url: largestThumbnail.url,
        width: largestThumbnail.width,
        height: largestThumbnail.height,
      },
      transcript: transcriptText,
      endscreen: endscreenLinks,
    };

    const markdown = `
![Thumbnail (${largestThumbnail.width}x${largestThumbnail.height})](${largestThumbnail.url})
# [${initialData.videoDetails.title}](${initialData.microformat.playerMicroformatRenderer.canonicalUrl})

**Visibility**: ${visibility}
**Uploaded by**: [${initialData.videoDetails.author}](${initialData.microformat.playerMicroformatRenderer.ownerProfileUrl})
**Uploaded at**: ${initialData.microformat.playerMicroformatRenderer.uploadDate}
**Published at**: ${initialData.microformat.playerMicroformatRenderer.publishDate}
**Length**: ${formattedLength}
**Views**: ${initialData.videoDetails.viewCount}
**Likes**: ${initialData.microformat.playerMicroformatRenderer.likeCount}
**Category**: ${initialData.microformat.playerMicroformatRenderer.category}

## Description

\`\`\`
${initialData.videoDetails.shortDescription}
\`\`\`

${transcriptMarkdown ? transcriptMarkdown + "\n\n" : ""}${
      endscreen.length > 0
        ? `## Endscreen

${endscreen
  .map(
    element =>
      `- [${element.endscreenElementRenderer.title.simpleText}](${new URL(
        element.endscreenElementRenderer.endpoint.commandMetadata.webCommandMetadata.url,
        engineResult.url,
      ).toString()})`,
  )
  .join("\n")}`
        : ""
    }`;

    return {
      ...engineResult,
      markdown,
      json,
      postprocessorsUsed: [
        ...(engineResult.postprocessorsUsed ?? []),
        "youtube",
      ],
    };
  },
};
