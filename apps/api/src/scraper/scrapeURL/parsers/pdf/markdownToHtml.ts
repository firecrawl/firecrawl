import * as marked from "marked";
import type { Logger } from "winston";

export async function safeMarkdownToHtml(
  markdown: string,
  logger: Logger,
  scrapeId: string,
): Promise<string> {
  try {
    return await marked.parse(markdown, { async: true });
  } catch (e) {
    logger.warn("marked.parse failed, falling back to <pre> wrapper", {
      error: e,
      scrapeId,
      markdownLength: markdown.length,
    });
    return `<pre>${markdown
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")}</pre>`;
  }
}
