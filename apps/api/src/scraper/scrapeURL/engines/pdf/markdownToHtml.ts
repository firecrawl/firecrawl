import { parse } from "marked";
import type { Logger } from "winston";

export async function safeMarkdownToHtml(
  markdown: string,
  logger: Logger,
  scrapeId: string,
): Promise<string> {
  try {
    return await parse(markdown, { async: true });
  } catch (error: unknown) {
    logger.warn("marked.parse failed, falling back to <pre> wrapper", {
      error,
      scrapeId,
      markdownLength: markdown.length,
    });
    return `<pre>${markdown
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")}</pre>`;
  }
}
