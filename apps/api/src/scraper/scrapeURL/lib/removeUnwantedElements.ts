// TODO: refactor

import { ScrapeOptions } from "../../../controllers/v2/types";
import { transformHtml } from "@mendable/firecrawl-rs";
import { logger } from "../../../lib/logger";
import { queryOMCESignatures } from "../../../services/index";
import { HtmlTransformError } from "../../../lib/error";

export const htmlTransform = async (
  html: string,
  url: string,
  scrapeOptions: ScrapeOptions,
) => {
  let omceSignatures: string[] | undefined = undefined;

  if (scrapeOptions.__experimental_omce) {
    try {
      const hostname =
        scrapeOptions.__experimental_omceDomain || new URL(url).hostname;
      omceSignatures = await queryOMCESignatures(hostname);
      logger.info("Got OMCE signatures", { signatures: omceSignatures.length });
    } catch (error) {
      logger.warn("Failed to get omce signatures.", {
        error,
        scrapeURL: url,
        module: "scrapeURL",
        method: "htmlTransform",
      });
    }
  }

  try {
    return await transformHtml({
      html,
      url,
      includeTags: (scrapeOptions.includeTags ?? [])
        .map(x => x.trim())
        .filter(x => x.length !== 0),
      excludeTags: (scrapeOptions.excludeTags ?? [])
        .map(x => x.trim())
        .filter(x => x.length !== 0),
      onlyMainContent: scrapeOptions.onlyMainContent,
      omceSignatures,
    });
  } catch (error) {
    logger.error("Failed to call html-transformer", {
      error,
      module: "scrapeURL",
      method: "htmlTransform",
    });
    throw new HtmlTransformError(
      error instanceof Error ? error.message : undefined,
    );
  }
};
