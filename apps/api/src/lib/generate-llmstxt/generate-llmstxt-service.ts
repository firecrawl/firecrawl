import { logger as _logger } from "../logger";
import { updateGeneratedLlmsTxt } from "./generate-llmstxt-redis";
import { getMapResults } from "../../controllers/v1/map";
import { z } from "zod";
import { scrapeDocument } from "../extract/document-scraper";
import {
  getLlmsTextFromCache,
  saveLlmsTextToCache,
} from "./generate-llmstxt-supabase";
import { billTeam } from "../../services/billing/credit_billing";
import { logJob } from "../../services/logging/log_job";
import { getModel } from "../generic-ai";
import { generateCompletions } from "../../scraper/scrapeURL/transformers/llmExtract";
import { CostTracking } from "../cost-tracking";
import { getACUCTeam } from "../../controllers/auth";
interface GenerateLLMsTextServiceOptions {
  generationId: string;
  teamId: string;
  apiKeyId: number | null;
  url: string;
  maxUrls: number;
  showFullText: boolean;
  cache?: boolean;
  subId?: string;
}

const descriptionSchema = z.object({
  description: z.string(),
  title: z.string(),
});

// Helper function to remove page separators
function removePageSeparators(text: string): string {
  return text.replace(/<\|firecrawl-page-\d+-lllmstxt\|>\n/g, "");
}

// Helper function to limit pages in full text
function limitPages(fullText: string, maxPages: number): string {
  const pages = fullText.split(/<\|firecrawl-page-\d+-lllmstxt\|>\n/);
  // First element is the header, so we start from index 1
  const limitedPages = pages.slice(0, maxPages + 1);
  return limitedPages.join("");
}

// Helper function to limit llmstxt entries
function limitLlmsTxtEntries(llmstxt: string, maxEntries: number): string {
  // Split by newlines
  const lines = llmstxt.split("\n");

  // Find the header line (starts with #)
  const headerIndex = lines.findIndex(line => line.startsWith("#"));
  if (headerIndex === -1) return llmstxt;

  // Get the header and the entries
  const header = lines[headerIndex];
  const entries = lines.filter(line => line.startsWith("- ["));

  // Take only the requested number of entries
  const limitedEntries = entries.slice(0, maxEntries);

  // Reconstruct the text
  return `${header}\n\n${limitedEntries.join("\n")}`;
}

export async function performGenerateLlmsTxt(
  options: GenerateLLMsTextServiceOptions,
) {
  const {
    generationId,
    teamId,
    url,
    maxUrls = 100,
    showFullText,
    cache = true,
    subId,
    apiKeyId,
  } = options;
  const startTime = Date.now();
  const logger = _logger.child({
    module: "generate-llmstxt",
    method: "performGenerateLlmsTxt",
    generationId,
    teamId,
  });
  const costTracking = new CostTracking();
  const acuc = await getACUCTeam(teamId);

  try {
    // Enforce max URL limit
    const effectiveMaxUrls = Math.min(maxUrls, 5000);

    // Check cache first, unless cache is set to false
    const cachedResult = cache
      ? await getLlmsTextFromCache(url, effectiveMaxUrls)
      : null;
    if (cachedResult) {
      logger.info("Found cached LLMs text", { url });

      // Limit pages and remove separators before returning
      const limitedFullText = limitPages(
        cachedResult.llmstxt_full,
        effectiveMaxUrls,
      );
      const cleanFullText = removePageSeparators(limitedFullText);

      // Limit llmstxt entries to match maxUrls
      const limitedLlmsTxt = limitLlmsTxtEntries(
        cachedResult.llmstxt,
        effectiveMaxUrls,
      );

      // Update final result with cached text
      await updateGeneratedLlmsTxt(generationId, {
        status: "completed",
        generatedText: limitedLlmsTxt,
        fullText: cleanFullText,
        showFullText: showFullText,
      });

      return {
        success: true,
        data: {
          generatedText: limitedLlmsTxt,
          fullText: cleanFullText,
          showFullText: showFullText,
        },
      };
    }

    // If not in cache, proceed with generation
    // First, get all URLs from the map controller
    const mapResult = await getMapResults({
      url,
      teamId,
      limit: effectiveMaxUrls,
      includeSubdomains: false,
      ignoreSitemap: false,
      includeMetadata: true,
      flags: acuc?.flags ?? null,
    });

    if (!mapResult || !mapResult.links) {
      throw new Error(`Failed to map URLs`);
    }

    _logger.debug("Mapping URLs", mapResult.links);

    const urls = mapResult.links;
    let llmstxt = `# ${url} llms.txt\n\n`;
    let llmsFulltxt = `# ${url} llms-full.txt\n\n`;

    // Process URLs in batches of 10
    for (let i = 0; i < urls.length; i += 10) {
      const batch = urls.slice(i, i + 10);

      const batchResults = await Promise.all(
        batch.map(async url => {
          _logger.debug(`Scraping URL: ${url}`);
          try {
            const document = await scrapeDocument(
              {
                url,
                teamId,
                origin: "llmstxt",
                timeout: 30000,
                isSingleUrl: true,
                flags: acuc?.flags ?? null,
                apiKeyId,
              },
              [],
              logger,
              { onlyMainContent: true },
            );

            if (!document || !document.markdown) {
              logger.error(`Failed to scrape URL ${url}`);
              return null;
            }

            _logger.debug(
              `Generating description for ${document.metadata?.url}`,
            );

            const { extract } = await generateCompletions({
              logger,
              model: getModel("gpt-4o-mini", "openai"),
              options: {
                systemPrompt: "",
                schema: descriptionSchema,
                prompt: `Generate a 9-10 word description and a 3-4 word title of the entire page based on ALL the content one will find on the page for this url: ${document.metadata?.url}. This will help in a user finding the page for its intended purpose.`,
              },
              markdown: document.markdown,
              costTrackingOptions: {
                costTracking,
                metadata: {
                  module: "generate-llmstxt",
                  method: "generateDescription",
                },
              },
              metadata: {
                teamId,
                functionId: "generate-llmstxt",
                llmsTxtId: generationId,
              },
            });

            return {
              title: extract.title,
              description: extract.description,
              url: document.metadata?.url,
              markdown: document.markdown,
            };
          } catch (error) {
            logger.error(`Failed to process URL ${url}`, { error });
            return null;
          }
        }),
      );

      // Process successful results from batch
      for (const result of batchResults) {
        if (!result) continue;

        llmstxt += `- [${result.title}](${result.url}): ${result.description}\n`;
        llmsFulltxt += `<|firecrawl-page-${i + batchResults.indexOf(result) + 1}-lllmstxt|>\n## ${result.title}\n${result.markdown}\n\n`;
      }

      // Update progress after each batch
      await updateGeneratedLlmsTxt(generationId, {
        status: "processing",
        generatedText: llmstxt,
        fullText: removePageSeparators(llmsFulltxt),
      });
    }

    // After successful generation, save to cache
    await saveLlmsTextToCache(url, llmstxt, llmsFulltxt, effectiveMaxUrls);

    // Limit pages and remove separators before final update
    const limitedFullText = limitPages(llmsFulltxt, effectiveMaxUrls);
    const cleanFullText = removePageSeparators(limitedFullText);

    // Update final result with both generated text and full text
    await updateGeneratedLlmsTxt(generationId, {
      status: "completed",
      generatedText: llmstxt,
      fullText: cleanFullText,
      showFullText: showFullText,
    });

    // Log job with token usage and sources
    await logJob({
      job_id: generationId,
      success: true,
      message: "LLMs text generation completed",
      num_docs: urls.length,
      docs: [{ llmstxt: llmstxt, llmsfulltxt: llmsFulltxt }],
      time_taken: (Date.now() - startTime) / 1000,
      team_id: teamId,
      mode: "llmstxt",
      url: url,
      scrapeOptions: options,
      origin: "api",
      num_tokens: 0,
      tokens_billed: 0,
      sources: {},
      cost_tracking: costTracking,
      credits_billed: urls.length,
      zeroDataRetention: false,
    });

    // Bill team for usage
    billTeam(teamId, subId, urls.length, apiKeyId, logger).catch(error => {
      logger.error(`Failed to bill team ${teamId} for ${urls.length} urls`, {
        teamId,
        count: urls.length,
        error,
      });
    });

    return {
      success: true,
      data: {
        generatedText: llmstxt,
        fullText: cleanFullText,
        showFullText: showFullText,
      },
    };
  } catch (error: any) {
    logger.error("Generate LLMs text error", { error });

    await updateGeneratedLlmsTxt(generationId, {
      status: "failed",
      error: error.message || "Unknown error occurred",
    });

    throw error;
  }
}
