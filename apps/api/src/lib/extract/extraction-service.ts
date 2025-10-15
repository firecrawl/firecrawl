import {
  Document,
  ExtractRequest,
  TokenUsage,
  URLTrace,
} from "../../controllers/v2/types";
import { isAgentExtractModelValid } from "../../controllers/v1/types";
import { logger as _logger } from "../logger";
import { generateBasicCompletion, processUrl } from "./url-processor";
import { scrapeDocument } from "./document-scraper";
import {
  generateCompletions,
  generateSchemaFromPrompt,
} from "../../scraper/scrapeURL/transformers/llmExtract";
import { billTeam } from "../../services/billing/credit_billing";
import { logJob } from "../../services/logging/log_job";
import { dereferenceSchema } from "./helpers/dereference-schema";
import { spreadSchemas } from "./helpers/spread-schemas";
import { transformArrayToObject } from "./helpers/transform-array-to-obj";
import { mixSchemaObjects } from "./helpers/mix-schema-objs";
import Ajv from "ajv";
const ajv = new Ajv();
import { getErrorContactMessage } from "../deployment";

import { ExtractStep, updateExtract } from "./extract-redis";
import { deduplicateObjectsArray } from "./helpers/deduplicate-objs-array";
import { mergeNullValObjs } from "./helpers/merge-null-val-objs";
import { CUSTOM_U_TEAMS } from "./config";
import {
  calculateFinalResultCost,
  calculateThinkingCost,
  estimateTotalCost,
} from "./usage/llm-cost";
import { analyzeSchemaAndPrompt } from "./completions/analyzeSchemaAndPrompt";
import { batchExtractPromise } from "./completions/batchExtract";
import { singleAnswerCompletion } from "./completions/singleAnswer";
import { SourceTracker } from "./helpers/source-tracker";
import { getCachedDocs, saveCachedDocs } from "./helpers/cached-docs";
import { normalizeUrl } from "../canonical-url";
import { search } from "../../search";
import { buildRephraseToSerpPrompt } from "./build-prompts";
import { getACUCTeam } from "../../controllers/auth";
import { CostLimitExceededError, CostTracking } from "../cost-tracking";

interface ExtractServiceOptions {
  request: ExtractRequest;
  teamId: string;
  subId?: string;
  cacheMode?: "load" | "save" | "direct";
  cacheKey?: string;
  agent?: boolean;
  apiKeyId: number | null;
  createdAt?: number;
}

export interface ExtractResult {
  success: boolean;
  data?: any;
  extractId: string;
  warning?: string;
  urlTrace?: URLTrace[];
  error?: string;
  tokenUsageBreakdown?: TokenUsage[];
  llmUsage?: number;
  totalUrlsScraped?: number;
  sources?: Record<string, string[]>;
}

type completions = {
  extract: Record<string, any>;
  numTokens: number;
  totalUsage: TokenUsage;
  warning?: string;
  sources?: string[];
};

export async function performExtraction(
  extractId: string,
  options: ExtractServiceOptions,
): Promise<ExtractResult> {
  const { request, teamId, subId, apiKeyId } = options;
  const createdAt = options.createdAt
    ? new Date(options.createdAt)
    : new Date();
  const urlTraces: URLTrace[] = [];
  let docsMap: Map<string, Document> = new Map();
  let singleAnswerCompletions: completions | null = null;
  let multiEntityCompletions: completions[] = [];
  let multiEntityResult: any = {};
  let singleAnswerResult: any = {};
  let totalUrlsScraped = 0;
  let sources: Record<string, string[]> = {};

  let costTracking = new CostTracking(subId ? null : 1.5);
  const acuc = await getACUCTeam(teamId);

  let log = {
    extractId,
    request,
  };

  const logger = _logger.child({
    module: "extract",
    method: "performExtraction",
    extractModel: "fire-1",
    extractId,
    teamId,
  });

  try {
    // If no URLs are provided, generate URLs from the prompt
    if ((!request.urls || request.urls.length === 0) && request.prompt) {
      logger.debug("Generating URLs from prompt...", {
        prompt: request.prompt,
      });
      const rephrasedPrompt = await generateBasicCompletion(
        buildRephraseToSerpPrompt(request.prompt),
        costTracking,
        { teamId, extractId },
      );
      let rptxt = rephrasedPrompt?.text.replace('"', "").replace("'", "") || "";
      const searchResults = await search({
        query: rptxt,
        logger,
        num_results: 10,
      });

      request.urls = searchResults.map(result => result.url) as string[];
    }
    if (request.urls && request.urls.length === 0) {
      logger.error("No search results found", {
        query: request.prompt,
      });

      const tokens_billed = 300 + calculateThinkingCost(costTracking);
      logJob({
        job_id: extractId,
        success: false,
        message: "No search results found",
        num_docs: 1,
        docs: [],
        time_taken: (new Date().getTime() - createdAt.getTime()) / 1000,
        team_id: teamId,
        mode: "extract",
        url: request.urls?.join(", ") || "",
        scrapeOptions: request,
        origin: request.origin ?? "api",
        integration: request.integration,
        num_tokens: 0,
        tokens_billed,
        sources,
        cost_tracking: costTracking,
        zeroDataRetention: false, // not supported
      });

      await billTeam(
        teamId,
        subId,
        tokens_billed,
        apiKeyId,
        logger,
        true,
      ).catch(error => {
        logger.error(
          `Failed to bill team ${teamId} for thinking tokens: ${error}`,
        );
      });

      return {
        success: false,
        error: "No search results found",
        extractId,
      };
    }

    const urls = request.urls || ([] as string[]);

    if (
      request.__experimental_cacheMode == "load" &&
      request.__experimental_cacheKey &&
      urls
    ) {
      logger.debug("Loading cached docs...");
      try {
        const cache = await getCachedDocs(
          urls,
          request.__experimental_cacheKey,
        );
        for (const doc of cache) {
          if (doc.metadata.url) {
            docsMap.set(normalizeUrl(doc.metadata.url), doc);
          }
        }
      } catch (error) {
        logger.error("Error loading cached docs", { error });
      }
    }

    // Token tracking
    let tokenUsage: TokenUsage[] = [];

    await updateExtract(extractId, {
      status: "processing",
      steps: [
        {
          step: ExtractStep.INITIAL,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          discoveredLinks: request.urls,
        },
      ],
    });

    let reqSchema = request.schema;
    if (!reqSchema && request.prompt) {
      const schemaGenRes = await generateSchemaFromPrompt(
        request.prompt,
        logger,
        costTracking,
        {
          teamId,
          functionId: "performExtraction/generateRequestSchema",
          extractId,
        },
      );
      reqSchema = schemaGenRes.extract;

      logger.debug("Generated request schema.", {
        originalSchema: request.schema,
        schema: reqSchema,
      });
    }

    if (reqSchema) {
      reqSchema = await dereferenceSchema(reqSchema);
    }

    logger.debug("Transformed schema.", {
      originalSchema: request.schema,
      schema: reqSchema,
    });

    let rSchema = reqSchema;

    // agent evaluates if the schema or the prompt has an array with big amount of items
    // also it checks if the schema any other properties that are not arrays
    // if so, it splits the results into 2 types of completions:
    // 1. the first one is a completion that will extract the array of items
    // 2. the second one is multiple completions that will extract the items from the array
    let startAnalyze = Date.now();
    const {
      isMultiEntity,
      multiEntityKeys,
      reasoning,
      keyIndicators,
      tokenUsage: schemaAnalysisTokenUsage,
    } = await analyzeSchemaAndPrompt(
      urls,
      reqSchema,
      request.prompt ?? "",
      logger,
      costTracking,
      {
        teamId,
        functionId: "performExtraction",
        extractId,
      },
    );

    logger.debug("Analyzed schema.", {
      isMultiEntity,
      multiEntityKeys,
      reasoning,
      keyIndicators,
    });

    tokenUsage.push(schemaAnalysisTokenUsage);

    let startMap = Date.now();
    let aggMapLinks: string[] = [];
    logger.debug("Processing URLs...", {
      urlCount: request.urls?.length || 0,
    });

    const urlPromises = urls.map(url =>
      processUrl(
        {
          url,
          prompt: request.prompt,
          teamId,
          allowExternalLinks: request.allowExternalLinks,
          origin: request.origin,
          limit: request.limit,
          includeSubdomains: request.includeSubdomains,
          schema: request.schema,
          log,
          isMultiEntity,
          reasoning,
          multiEntityKeys,
          keyIndicators,
          extractId,
        },
        urlTraces,
        (links: string[]) => {
          aggMapLinks.push(...links);
          updateExtract(extractId, {
            steps: [
              {
                step: ExtractStep.MAP,
                startedAt: startMap,
                finishedAt: Date.now(),
                discoveredLinks: aggMapLinks,
              },
            ],
          });
        },
        logger.child({ module: "extract", method: "processUrl", url }),
        costTracking,
        acuc?.flags ?? null,
      ),
    );

    const processedUrls = await Promise.all(urlPromises);
    let links = processedUrls.flat().filter(url => url);
    logger.debug("Processed URLs.", {
      linkCount: links.length,
    });

    if (links.length === 0) {
      links = urls.map(x => x.replace(/\*$/g, ""));
      logger.warn(
        "0 links! Doing just the original URLs. (without * wildcard)",
        {
          linkCount: links.length,
        },
      );
    }

    log["links"] = links;
    log["linksLength"] = links.length;

    await updateExtract(extractId, {
      status: "processing",
      steps: [
        {
          step: ExtractStep.MAP_RERANK,
          startedAt: startMap,
          finishedAt: Date.now(),
          discoveredLinks: links,
        },
      ],
    });

    if (isMultiEntity && reqSchema) {
      log["isMultiEntity"] = true;
      logger.debug("=== MULTI-ENTITY ===");

      const { singleAnswerSchema, multiEntitySchema } = await spreadSchemas(
        reqSchema,
        multiEntityKeys,
      );
      rSchema = singleAnswerSchema;
      logger.debug("Spread schemas.", {
        singleAnswerSchema,
        multiEntitySchema,
      });

      await updateExtract(extractId, {
        status: "processing",
        steps: [
          {
            step: ExtractStep.MULTI_ENTITY,
            startedAt: startAnalyze,
            finishedAt: Date.now(),
            discoveredLinks: [],
          },
        ],
      });

      const timeout = 60000;

      await updateExtract(extractId, {
        status: "processing",
        steps: [
          {
            step: ExtractStep.MULTI_ENTITY_SCRAPE,
            startedAt: startAnalyze,
            finishedAt: Date.now(),
            discoveredLinks: links,
          },
        ],
      });

      logger.debug("Starting multi-entity scrape...");
      let startScrape = Date.now();
      log["docsSizeBeforeMultiEntityScrape"] = docsMap.size;

      const scrapePromises = links.map(url => {
        if (!docsMap.has(normalizeUrl(url))) {
          return scrapeDocument(
            {
              url,
              teamId,
              origin: "extract",
              timeout,
              flags: acuc?.flags ?? null,
              apiKeyId,
            },
            urlTraces,
            logger.child({
              module: "extract",
              method: "scrapeDocument",
              url,
              isMultiEntity: true,
            }),
            {
              timeout: 300000,
              ...request.scrapeOptions,

              // Needs to be true for multi-entity to work properly
              onlyMainContent: true,
            },
          );
        }
        return docsMap.get(normalizeUrl(url));
      });

      let multyEntityDocs = (await Promise.all(scrapePromises)).filter(
        (doc): doc is Document => doc !== null,
      );

      log["docsSizeAfterMultiEntityScrape"] = scrapePromises.length;

      logger.debug("Multi-entity scrape finished.", {
        docCount: multyEntityDocs.length,
      });

      totalUrlsScraped += multyEntityDocs.length;

      let endScrape = Date.now();

      await updateExtract(extractId, {
        status: "processing",
        steps: [
          {
            step: ExtractStep.MULTI_ENTITY_SCRAPE,
            startedAt: startScrape,
            finishedAt: endScrape,
            discoveredLinks: links,
          },
        ],
      });

      for (const doc of multyEntityDocs) {
        if (doc?.metadata?.url) {
          docsMap.set(normalizeUrl(doc.metadata.url), doc);
        }
      }

      logger.debug("Updated docsMap.", { docsMapSize: docsMap.size }); // useful for error probing

      // Process docs in chunks with queue style processing
      const chunkSize = 50;
      const timeoutCompletion = 45000; // 45 second timeout
      const chunks: Document[][] = [];
      const extractionResults: { extract: any; url: string }[] = [];

      // Split into chunks
      for (let i = 0; i < multyEntityDocs.length; i += chunkSize) {
        chunks.push(multyEntityDocs.slice(i, i + chunkSize));
      }

      const sessionIds = chunks.map(() => "fc-" + crypto.randomUUID());
      await updateExtract(extractId, {
        status: "processing",
        steps: [
          {
            step: ExtractStep.MULTI_ENTITY_AGENT_SCRAPE,
            startedAt: Date.now(),
            finishedAt: null,
          },
        ],
        sessionIds,
      });

      // Process chunks sequentially with timeout
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const sessionId = sessionIds[i];
        const chunkPromises = chunk.map(async doc => {
          try {
            ajv.compile(multiEntitySchema);

            // Wrap in timeout promise
            const timeoutPromise = new Promise(resolve => {
              setTimeout(() => resolve(null), timeoutCompletion);
            });

            const completionPromise = batchExtractPromise(
              {
                multiEntitySchema,
                links,
                prompt: request.prompt ?? "",
                systemPrompt: request.systemPrompt ?? "",
                doc,
                useAgent: isAgentExtractModelValid(request.agent?.model),
                extractId,
                sessionId,
                costTracking,
                metadata: {
                  teamId,
                  functionId: "performExtraction/multiEntity",
                  extractId,
                },
              },
              logger,
            );

            // Race between timeout and completion
            const multiEntityCompletion = (await completionPromise) as Awaited<
              ReturnType<typeof batchExtractPromise>
            >;

            // TODO: merge multiEntityCompletion.extract to fit the multiEntitySchema

            // Track multi-entity extraction tokens
            if (multiEntityCompletion) {
              tokenUsage.push(multiEntityCompletion.totalUsage);

              if (multiEntityCompletion.extract) {
                return {
                  extract: multiEntityCompletion.extract,
                  url: doc.metadata.url || doc.metadata.sourceURL || "",
                };
              }
            }

            // console.log(multiEntityCompletion.extract)
            // if (!multiEntityCompletion.extract?.is_content_relevant) {
            //   console.log(`Skipping extraction for ${doc.metadata.url} as content is not relevant`);
            //   return null;
            // }

            // Update token usage in traces
            // if (multiEntityCompletion && multiEntityCompletion.numTokens) {
            //   const totalLength = docs.reduce(
            //     (sum, doc) => sum + (doc.markdown?.length || 0),
            //     0,
            //   );
            //   docs.forEach((doc) => {
            //     if (doc.metadata?.sourceURL) {
            //       const trace = urlTraces.find(
            //         (t) => t.url === doc.metadata.sourceURL,
            //       );
            //       if (trace && trace.contentStats) {
            //         trace.contentStats.tokensUsed = Math.floor(
            //           ((doc.markdown?.length || 0) / totalLength) *
            //             (multiEntityCompletion?.numTokens || 0),
            //         );
            //       }
            //     }
            //   });
            //  }

            // if (multiEntityCompletion.extract && multiEntityCompletion.extract.extraction_confidence < 3) {
            //   console.log(`Skipping extraction for ${doc.metadata.url} as confidence is too low (${multiEntityCompletion.extract.extraction_confidence})`);
            //   return null;
            // }

            return null;
          } catch (error) {
            if (error instanceof CostLimitExceededError) {
              throw error;
            }

            logger.error(`Failed to process document.`, {
              error,
              url: doc.metadata.url ?? doc.metadata.sourceURL!,
            });
            return null;
          }
        });
        // Wait for current chunk to complete before processing next chunk
        const chunkResults = await Promise.all(chunkPromises);
        const validResults = chunkResults.filter(
          (result): result is { extract: any; url: string } => result !== null,
        );
        extractionResults.push(...validResults);
        // Merge all extracts from valid results into a single array
        const extractArrays = validResults.map(r =>
          Array.isArray(r.extract) ? r.extract : [r.extract],
        );
        const mergedExtracts = extractArrays.flat();
        multiEntityCompletions.push(...mergedExtracts);
        multiEntityCompletions = multiEntityCompletions.filter(c => c !== null);
        logger.debug("All multi-entity completion chunks finished.", {
          completionCount: multiEntityCompletions.length,
        });
        log["multiEntityCompletionsLength"] = multiEntityCompletions.length;
      }

      try {
        // Use SourceTracker to handle source tracking
        const sourceTracker = new SourceTracker();
        logger.debug("Created SourceTracker instance");

        // Transform and merge results while preserving sources
        try {
          sourceTracker.transformResults(
            extractionResults,
            multiEntitySchema,
            false,
          );
          logger.debug("Successfully transformed results with sourceTracker");
        } catch (error) {
          logger.error(`Error in sourceTracker.transformResults:`, { error });
          throw error;
        }

        try {
          multiEntityResult = transformArrayToObject(
            multiEntitySchema,
            multiEntityCompletions,
          );
          logger.debug("Successfully transformed array to object");
        } catch (error) {
          logger.error(`Error in transformArrayToObject:`, { error });
          throw error;
        }

        // Track sources before deduplication
        try {
          sourceTracker.trackPreDeduplicationSources(multiEntityResult);
          logger.debug("Successfully tracked pre-deduplication sources");
        } catch (error) {
          logger.error(`Error in trackPreDeduplicationSources:`, { error });
          throw error;
        }

        // Apply deduplication and merge
        try {
          multiEntityResult = deduplicateObjectsArray(multiEntityResult);
          logger.debug("Successfully deduplicated objects array");
        } catch (error) {
          logger.error(`Error in deduplicateObjectsArray:`, { error });
          throw error;
        }

        try {
          multiEntityResult = mergeNullValObjs(multiEntityResult);
          logger.debug("Successfully merged null value objects");
        } catch (error) {
          logger.error(`Error in mergeNullValObjs:`, { error });
          throw error;
        }

        // Map sources to final deduplicated/merged items
        try {
          const multiEntitySources = sourceTracker.mapSourcesToFinalItems(
            multiEntityResult,
            multiEntityKeys,
          );
          Object.assign(sources, multiEntitySources);
          logger.debug("Successfully mapped sources to final items");
        } catch (error) {
          logger.error(`Error in mapSourcesToFinalItems:`, { error });
          throw error;
        }
      } catch (error) {
        logger.error(`Failed to transform array to object`, {
          error,
          errorMessage: error.message,
          errorStack: error.stack,
          multiEntityResult: JSON.stringify(multiEntityResult),
          multiEntityCompletions: JSON.stringify(multiEntityCompletions),
          multiEntitySchema: JSON.stringify(multiEntitySchema),
        });
        const tokens_billed = 300 + calculateThinkingCost(costTracking);
        logJob({
          job_id: extractId,
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "Failed to transform array to object",
          num_docs: 1,
          docs: [],
          time_taken: (new Date().getTime() - createdAt.getTime()) / 1000,
          team_id: teamId,
          mode: "extract",
          url: request.urls?.join(", ") || "",
          scrapeOptions: request,
          origin: request.origin ?? "api",
          integration: request.integration,
          num_tokens: 0,
          tokens_billed,
          sources,
          cost_tracking: costTracking,
          zeroDataRetention: false, // not supported
        });
        await billTeam(
          teamId,
          subId,
          tokens_billed,
          apiKeyId,
          logger,
          true,
        ).catch(error => {
          logger.error(
            `Failed to bill team ${teamId} for thinking tokens: ${error}`,
          );
        });
        return {
          success: false,
          error: getErrorContactMessage(),
          extractId,
          urlTrace: urlTraces,
          totalUrlsScraped,
        };
      }
    }
    if (
      rSchema &&
      Object.keys(rSchema).length > 0 &&
      rSchema.properties &&
      Object.keys(rSchema.properties).length > 0
    ) {
      log["isSingleEntity"] = true;
      logger.debug("=== SINGLE PAGES ===", {
        linkCount: links.length,
        schema: rSchema,
      });

      // Scrape documents
      const timeout = 60000;
      let singleAnswerDocs: Document[] = [];

      // let rerank = await rerankLinks(links.map((url) => ({ url })), request.prompt ?? JSON.stringify(request.schema), urlTraces);

      await updateExtract(extractId, {
        status: "processing",
        steps: [
          {
            step: ExtractStep.SCRAPE,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            discoveredLinks: links,
          },
        ],
      });
      log["docsSizeBeforeSingleEntityScrape"] = docsMap.size;
      const scrapePromises = links.map(url => {
        if (!docsMap.has(normalizeUrl(url))) {
          return scrapeDocument(
            {
              url,
              teamId,
              origin: "extract",
              timeout,
              flags: acuc?.flags ?? null,
              apiKeyId,
            },
            urlTraces,
            logger.child({
              module: "extract",
              method: "scrapeDocument",
              url,
              isMultiEntity: false,
            }),
            {
              timeout: 300000,
              ...request.scrapeOptions,
            },
          );
        }
        return docsMap.get(normalizeUrl(url));
      });

      try {
        const results = await Promise.all(scrapePromises);
        log["docsSizeAfterSingleEntityScrape"] = docsMap.size;

        for (const doc of results) {
          if (doc?.metadata?.url) {
            docsMap.set(normalizeUrl(doc.metadata.url), doc);
          }
        }
        logger.debug("Updated docsMap.", { docsMapSize: docsMap.size }); // useful for error probing

        const validResults = results.filter(
          (doc): doc is Document => doc !== null,
        );
        singleAnswerDocs.push(...validResults);
        totalUrlsScraped += validResults.length;

        logger.debug("Scrapes finished.", { docCount: validResults.length });
      } catch (error) {
        const tokens_billed = 300 + calculateThinkingCost(costTracking);
        logJob({
          job_id: extractId,
          success: false,
          message: error.message,
          num_docs: 1,
          docs: [],
          time_taken: (new Date().getTime() - createdAt.getTime()) / 1000,
          team_id: teamId,
          mode: "extract",
          url: request.urls?.join(", ") || "",
          scrapeOptions: request,
          origin: request.origin ?? "api",
          integration: request.integration,
          num_tokens: 0,
          tokens_billed,
          sources,
          cost_tracking: costTracking,
          zeroDataRetention: false, // not supported
        });
        await billTeam(
          teamId,
          subId,
          tokens_billed,
          apiKeyId,
          logger,
          true,
        ).catch(error => {
          logger.error(
            `Failed to bill team ${teamId} for thinking tokens: ${error}`,
          );
        });
        return {
          success: false,
          error: error.message,
          extractId,
          urlTrace: urlTraces,
          totalUrlsScraped,
        };
      }

      if (docsMap.size == 0) {
        // All urls are invalid
        const errorMessage =
          "All provided URLs are either invalid, unsupported or failed to be scraped.";
        logger.error(errorMessage);
        const tokens_billed = 300 + calculateThinkingCost(costTracking);
        await billTeam(
          teamId,
          subId,
          tokens_billed,
          apiKeyId,
          logger,
          true,
        ).catch(error => {
          logger.error(
            `Failed to bill team ${teamId} for thinking tokens: ${error}`,
          );
        });
        logJob({
          job_id: extractId,
          success: false,
          message: errorMessage,
          num_docs: 1,
          docs: [],
          time_taken: (new Date().getTime() - createdAt.getTime()) / 1000,
          team_id: teamId,
          mode: "extract",
          url: request.urls?.join(", ") || "",
          scrapeOptions: request,
          origin: request.origin ?? "api",
          integration: request.integration,
          num_tokens: 0,
          tokens_billed,
          sources,
          cost_tracking: costTracking,
          zeroDataRetention: false, // not supported
        });
        return {
          success: false,
          error: errorMessage,
          extractId,
          urlTrace: request.urlTrace ? urlTraces : undefined,
          totalUrlsScraped: 0,
        };
      }

      let thisSessionId = "fc-" + crypto.randomUUID();

      await updateExtract(extractId, {
        status: "processing",
        steps: [
          {
            step: ExtractStep.EXTRACT,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            discoveredLinks: links,
          },
        ],
        sessionIds: [thisSessionId],
      });

      // Generate completions
      logger.debug("Generating singleAnswer completions...");
      log["singleAnswerDocsLength"] = singleAnswerDocs.length;
      let {
        extract: completionResult,
        tokenUsage: singleAnswerTokenUsage,
        sources: singleAnswerSources,
      } = await singleAnswerCompletion({
        singleAnswerDocs,
        rSchema,
        links,
        prompt: request.prompt ?? "",
        systemPrompt: request.systemPrompt ?? "",
        useAgent: isAgentExtractModelValid(request.agent?.model),
        extractId,
        sessionId: thisSessionId,
        costTracking,
        metadata: {
          teamId,
          functionId: "performExtraction",
          extractId,
        },
      });
      logger.debug("Done generating singleAnswer completions.");

      singleAnswerResult = transformArrayToObject(rSchema, completionResult);

      singleAnswerResult = deduplicateObjectsArray(singleAnswerResult);
      // Track single answer extraction tokens and sources
      if (completionResult) {
        tokenUsage.push(singleAnswerTokenUsage);

        // Add sources for top-level properties in single answer
        if (rSchema?.properties) {
          Object.keys(rSchema.properties).forEach(key => {
            if (completionResult[key] !== undefined) {
              sources[key] =
                singleAnswerSources ||
                singleAnswerDocs.map(
                  doc => doc.metadata.url || doc.metadata.sourceURL || "",
                );
            }
          });
        }
      }

      // singleAnswerResult = completionResult;
      // singleAnswerCompletions = singleAnswerResult;

      // Update token usage in traces
      // if (completions && completions.numTokens) {
      //   const totalLength = docs.reduce(
      //     (sum, doc) => sum + (doc.markdown?.length || 0),
      //     0,
      //   );
      //   docs.forEach((doc) => {
      //     if (doc.metadata?.sourceURL) {
      //       const trace = urlTraces.find((t) => t.url === doc.metadata.sourceURL);
      //       if (trace && trace.contentStats) {
      //         trace.contentStats.tokensUsed = Math.floor(
      //           ((doc.markdown?.length || 0) / totalLength) *
      //             (completions?.numTokens || 0),
      //         );
      //       }
      //     }
      //   });
      // }
    }

    log["singleAnswerResult"] = singleAnswerResult;
    log["multiEntityResult"] = multiEntityResult;

    let finalResult = reqSchema
      ? await mixSchemaObjects(
          reqSchema,
          singleAnswerResult,
          multiEntityResult,
          logger.child({ method: "mixSchemaObjects" }),
        )
      : singleAnswerResult || multiEntityResult;

    // Tokenize final result to get token count
    // let finalResultTokens = 0;
    // if (finalResult) {
    //   const finalResultStr = JSON.stringify(finalResult);
    //   finalResultTokens = numTokensFromString(finalResultStr, "gpt-4o");

    // }
    // // Deduplicate and validate final result against schema
    // if (reqSchema && finalResult && finalResult.length <= extractConfig.DEDUPLICATION.MAX_TOKENS) {
    //   const schemaValidation = await generateCompletions(
    //     logger.child({ method: "extractService/validateAndDeduplicate" }),
    //     {
    //       mode: "llm",
    //       systemPrompt: `You are a data validator and deduplicator. Your task is to:
    //       1. Remove any duplicate entries in the data extracted by merging that into a single object according to the provided shcema
    //       2. Ensure all data matches the provided schema
    //       3. Keep only the highest quality and most complete entries when duplicates are found.

    //       Do not change anything else. If data is null keep it null. If the schema is not provided, return the data as is.`,
    //       prompt: `Please validate and merge the duplicate entries in this data according to the schema provided:\n

    //       <start of extract data>

    //       ${JSON.stringify(finalResult)}

    //       <end of extract data>

    //       <start of schema>

    //       ${JSON.stringify(reqSchema)}

    //       <end of schema>
    //       `,
    //       schema: reqSchema,
    //     },
    //     undefined,
    //     undefined,
    //     true,
    //     "gpt-4o"
    //   );
    //   console.log("schemaValidation", schemaValidation);

    //   console.log("schemaValidation", finalResult);

    //   if (schemaValidation?.extract) {
    //     tokenUsage.push(schemaValidation.totalUsage);
    //     finalResult = schemaValidation.extract;
    //   }
    // }

    const totalTokensUsed = tokenUsage.reduce((a, b) => a + b.totalTokens, 0);
    const llmUsage = estimateTotalCost(tokenUsage);
    let tokensToBill =
      calculateFinalResultCost(finalResult) +
      calculateThinkingCost(costTracking);

    if (CUSTOM_U_TEAMS.includes(teamId)) {
      tokensToBill = 1;
    }

    // Bill team for usage
    await billTeam(teamId, subId, tokensToBill, apiKeyId, logger, true).catch(
      error => {
        logger.error(
          `Failed to bill team ${teamId} for ${tokensToBill} tokens: ${error}`,
        );
      },
    );

    // Log job with token usage and sources
    logJob({
      job_id: extractId,
      success: true,
      message: "Extract completed",
      num_docs: 1,
      docs: finalResult ?? {},
      time_taken: (new Date().getTime() - createdAt.getTime()) / 1000,
      team_id: teamId,
      mode: "extract",
      url: request.urls?.join(", ") || "",
      scrapeOptions: request,
      origin: request.origin ?? "api",
      integration: request.integration,
      num_tokens: totalTokensUsed,
      tokens_billed: tokensToBill,
      sources,
      cost_tracking: costTracking,
      zeroDataRetention: false, // not supported
    }).then(() => {
      updateExtract(extractId, {
        status: "completed",
        llmUsage,
        sources,
        tokensBilled: tokensToBill,
        // costTracking,
      }).catch(error => {
        logger.error(
          `Failed to update extract ${extractId} status to completed: ${error}`,
        );
      });
    });

    logger.debug("Done!");

    if (
      request.__experimental_cacheMode == "save" &&
      request.__experimental_cacheKey
    ) {
      logger.debug("Saving cached docs...");
      try {
        await saveCachedDocs(
          [...docsMap.values()],
          request.__experimental_cacheKey,
        );
      } catch (error) {
        logger.error("Error saving cached docs", { error });
      }
    }

    // fs.writeFile(
    //   `logs/${request.urls?.[0].replaceAll("https://", "").replaceAll("http://", "").replaceAll("/", "-").replaceAll(".", "-")}-extract-${extractId}.json`,
    //   JSON.stringify(log, null, 2),
    // );

    return {
      success: true,
      data: finalResult ?? {},
      extractId,
      warning: undefined,
      urlTrace: request.urlTrace ? urlTraces : undefined,
      llmUsage,
      totalUrlsScraped,
      sources,
    };
  } catch (error) {
    const tokens_billed = 300 + calculateThinkingCost(costTracking);
    await billTeam(teamId, subId, tokens_billed, apiKeyId, logger, true).catch(
      error => {
        logger.error(
          `Failed to bill team ${teamId} for thinking tokens: ${error}`,
        );
      },
    );
    await logJob({
      job_id: extractId,
      success: false,
      message:
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "An unexpected error occurred",
      num_docs: 1,
      docs: [],
      time_taken: (new Date().getTime() - createdAt.getTime()) / 1000,
      team_id: teamId,
      mode: "extract",
      url: request.urls?.join(", ") || "",
      scrapeOptions: request,
      origin: request.origin ?? "api",
      integration: request.integration,
      num_tokens: 0,
      tokens_billed,
      sources,
      cost_tracking: costTracking,
      zeroDataRetention: false, // not supported
    });

    throw error;
  }
}
