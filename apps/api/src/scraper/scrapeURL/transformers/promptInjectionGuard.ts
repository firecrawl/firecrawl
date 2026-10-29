import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { checkForPromptInjection } from "../lib/promptInjectionGuard";
import { MAX_JSON_EXTRACTION_MARKDOWN_CHARS } from "../lib/extractSmartScrape";

// Runs before every LLM-backed format, so blocked content never reaches one.
export async function performPromptInjectionGuard(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!meta.options.checkPromptInjection) {
    return document;
  }

  const markdown = document.markdown ?? "";
  const scannedFully =
    markdown.length <= MAX_JSON_EXTRACTION_MARKDOWN_CHARS &&
    (await checkForPromptInjection({
      markdown,
      logger: meta.logger,
      costTracking: meta.costTracking,
      metadata: {
        teamId: meta.internalOptions.teamId,
        functionId: meta.internalOptions.llmTelemetry?.functionId,
        scrapeId: meta.id,
      },
      zeroDataRetention: !!meta.internalOptions.zeroDataRetention,
    }));

  if (scannedFully) {
    return document;
  }

  // The guard fee does not bill in this case (see scrape-billing.ts).
  return {
    ...document,
    warning:
      "The prompt injection check could not scan all of the page content, so some of it was not checked. The prompt injection check was not billed." +
      (document.warning ? " " + document.warning : ""),
  };
}
