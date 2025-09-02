import { Document } from "../../../controllers/v1/types";
import { Meta } from "..";
import { logger } from "../../../lib/logger";
import { parseMarkdown } from "../../../lib/html-to-markdown";
import { smartScrape, SmartScrapeResult } from "../lib/smartScrape";
import { hasFormatOfType } from "../../../lib/format-utils";

export async function performAgent(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (meta.internalOptions.v1Agent?.prompt) {
    if (meta.internalOptions.zeroDataRetention) {
      document.warning =
        "Agent is not supported with zero data retention." +
        (document.warning ? " " + document.warning : "");
      return document;
    }

    const url: string | undefined = document.url || document.metadata.sourceURL;

    if (!url) {
      logger.error(
        "document.url or document.metadata.sourceURL is undefined -- this is unexpected",
      );
      // throw new Error("document.url or document.metadata.sourceURL is undefined -- this is unexpected");
      return document;
    }

    const prompt = meta.internalOptions.v1Agent?.prompt ?? undefined;
    const sessionId = meta.internalOptions.v1Agent?.sessionId ?? undefined;

    let smartscrapeResults: SmartScrapeResult;
    try {
      smartscrapeResults = await smartScrape({
        url,
        prompt,
        sessionId,
        scrapeId: meta.id,
        costTracking: meta.costTracking,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Cost limit exceeded") {
        logger.error("Cost limit exceeded", { error });
        document.warning =
          "Smart scrape cost limit exceeded." +
          (document.warning ? " " + document.warning : "");
        return document;
      } else {
        throw error;
      }
    }

    const html =
      smartscrapeResults.scrapedPages[
        smartscrapeResults.scrapedPages.length - 1
      ].html;

    if (hasFormatOfType(meta.options.formats, "markdown")) {
      const markdown = await parseMarkdown(html);
      document.markdown = markdown;
    }
    if (hasFormatOfType(meta.options.formats, "html")) {
      document.html = html;
    }
  }

  return document;
}
