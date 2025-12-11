import { MapDocument, URLTrace } from "../../controllers/v1/types";
import { logger } from "../logger";
import { generateCompletions } from "../../scraper/scrapeURL/transformers/llmExtract";
import { buildRerankerUserPrompt } from "./build-prompts";
import { getModel } from "../generic-ai";
import { CostTracking } from "../cost-tracking";

const THRESHOLD_FOR_SINGLEPAGE = 0.6;
const THRESHOLD_FOR_MULTIENTITY = 0.45;

type RerankerResult = {
  mapDocument: (MapDocument & { relevanceScore?: number; reason?: string })[];
  tokensUsed: number;
  cost: number;
};

type RerankerOptions = {
  links: MapDocument[];
  searchQuery: string;
  urlTraces: URLTrace[];
  isMultiEntity: boolean;
  reasoning: string;
  multiEntityKeys: string[];
  keyIndicators: string[];
  costTracking: CostTracking;
  metadata: { teamId: string; functionId?: string; extractId?: string };
};

export async function rerankLinksWithLLM(
  options: RerankerOptions,
): Promise<RerankerResult> {
  const {
    links,
    searchQuery,
    urlTraces,
    isMultiEntity,
    reasoning,
    multiEntityKeys,
    keyIndicators,
    metadata,
  } = options;
  const chunkSize = 5000;
  const chunks: MapDocument[][] = [];
  const TIMEOUT_MS = 60000;
  const MAX_RETRIES = 2;
  let totalTokensUsed = 0;

  // await fs.writeFile(
  //   `logs/links-${crypto.randomUUID()}.txt`,
  //   JSON.stringify(links, null, 2),
  // );

  // Split links into chunks of 200
  for (let i = 0; i < links.length; i += chunkSize) {
    chunks.push(links.slice(i, i + chunkSize));
  }

  // console.log(`Total links: ${mappedLinks.length}, Number of chunks: ${chunks.length}`);

  const schema = {
    type: "object",
    properties: {
      relevantLinks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            relevanceScore: { type: "number" },
            reason: {
              type: "string",
              description:
                "The reason why you chose the score for this link given the intent.",
            },
          },
          required: ["url", "relevanceScore", "reason"],
        },
      },
    },
    required: ["relevantLinks"],
  };

  let totalCost = 0;

  const results = await Promise.all(
    chunks.map(async (chunk, chunkIndex) => {
      // console.log(`Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length} links`);

      const linksContent = chunk
        .map(
          link =>
            `URL: ${link.url}${link.title ? `\nTitle: ${link.title}` : ""}${link.description ? `\nDescription: ${link.description}` : ""}`,
        )
        .join("\n\n");

      // fs.writeFile(
      //   `logs/links-content-${crypto.randomUUID()}.txt`,
      //   linksContent,
      // );

      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          // const timeoutPromise = new Promise<null>(resolve => {
          //   setTimeout(() => resolve(null), TIMEOUT_MS);
          // });

          const systemPrompt = `You are analyzing URLs for ${isMultiEntity ? "collecting multiple items" : "specific information"}.
          The user's query is: ${searchQuery}
          ${
            isMultiEntity
              ? `IMPORTANT: This is a multi-entity extraction task looking for ${multiEntityKeys.join(", ")}.
               Score URLs higher if they contain ANY instance of the target entities.
               Key indicators to look for: ${keyIndicators.join(", ")}`
              : `IMPORTANT: This is a specific information task.
               Score URLs based on precision and relevance to answering the query.`
          }
        
          Scoring guidelines:
          ${
            isMultiEntity
              ? `
          - 1.0: Contains ANY instance of target entities, even just one. Give this score if page has any relevant entity. If you are not sure if this page is relevant or not, give it a score of 1.0
          - 0.8: Contains entity but may be incomplete information
          - 0.6: Mentions entity type but no clear instance
          - 0.4: Only tangentially related to entity type
          - Below 0.4: No mention of relevant entities, or duplicates
          
          Reason: ${reasoning}
          `
              : `
          - 1.0: Contains direct, authoritative answer to query. Give this score if unsure about relevance. If you are not sure if this page is relevant or not, give it a score of 1.0
          - 0.8: Contains information that directly helps answer the query
          - 0.6: Contains related information that partially answers query
          - Below 0.6: Information too general or not focused on query
          `
          }`;

          // dumpToFile(new Date().toISOString(),[buildRerankerSystemPrompt(), buildRerankerUserPrompt(searchQuery), schema, linksContent])
          // const gemini = getGemini();
          // const model = getGemini()
          let completion: any;
          try {
            const completionPromise = generateCompletions({
              model: getModel("gemini-2.5-pro", "vertex"),
              retryModel: getModel("gemini-2.5-pro", "google"),
              logger: logger.child({
                method: "rerankLinksWithLLM",
                chunk: chunkIndex + 1,
                retry,
              }),
              options: {
                systemPrompt: systemPrompt,
                prompt: buildRerankerUserPrompt(searchQuery),
                schema: schema,
                // temperature: isMultiEntity ? 0.5 : 0.3,
              },
              // providerOptions: {
              //   anthropic: {
              //     thinking: { type: 'enabled', budgetTokens: 12000 },
              //     tool_choice: "auto",
              //   },
              // },
              markdown: linksContent,
              isExtractEndpoint: true,
              costTrackingOptions: {
                costTracking: options.costTracking,
                metadata: {
                  module: "extract",
                  method: "rerankLinksWithLLM",
                },
              },
              metadata: {
                ...metadata,
                functionId: metadata.functionId
                  ? metadata.functionId + "/rerankLinksWithLLM"
                  : "rerankLinksWithLLM",
              },
            });

            completion = await completionPromise;
            totalCost += completion.cost;
          } catch (error) {
            console.warn(
              `Error processing chunk ${chunkIndex + 1} attempt ${retry + 1}:`,
              error,
            );
          }

          // await fs.writeFile(
          //   `logs/reranker-${crypto.randomUUID()}.json`,
          //   JSON.stringify(completion, null, 2),
          // );

          if (!completion) {
            // console.log(`Chunk ${chunkIndex + 1}: Timeout on attempt ${retry + 1}`);
            continue;
          }

          if (!completion.extract?.relevantLinks) {
            // console.warn(`Chunk ${chunkIndex + 1}: No relevant links found in completion response`);
            return [];
          }

          totalTokensUsed += completion.numTokens || 0;
          // console.log(`Chunk ${chunkIndex + 1}: Found ${completion.extract.relevantLinks.length} relevant links`);
          return completion.extract.relevantLinks;
        } catch (error) {
          console.warn(
            `Error processing chunk ${chunkIndex + 1} attempt ${retry + 1}:`,
            error,
          );
          if (retry === MAX_RETRIES) {
            // console.log(`Chunk ${chunkIndex + 1}: Max retries reached, returning empty array`);
            return [];
          }
        }
      }
      return [];
    }),
  );

  // console.log(`Processed ${results.length} chunks`);

  // Flatten results and sort by relevance score
  const flattenedResults = results
    .flat()
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
  // console.log(`Total relevant links found: ${flattenedResults.length}`);

  // Map back to MapDocument format, keeping ALL links for testing
  const relevantLinks = flattenedResults
    .map(result => {
      if (
        result.relevanceScore >
        (isMultiEntity ? THRESHOLD_FOR_MULTIENTITY : THRESHOLD_FOR_SINGLEPAGE)
      ) {
        const link = links.find(link => link.url === result.url);
        if (link) {
          return {
            ...link,
            relevanceScore: result.relevanceScore
              ? parseFloat(result.relevanceScore)
              : 0,
            reason: result.reason,
          };
        }
      }
      return undefined;
    })
    .filter((link): link is NonNullable<typeof link> => link !== undefined);

  // Add debug logging for testing
  // fs.writeFile(
  //   `logs/reranker-aaa-${crypto.randomUUID()}.json`,
  //   JSON.stringify(
  //     {
  //       totalResults: relevantLinks.length,
  //       scores: relevantLinks.map((l) => ({
  //         url: l.url,
  //         score: l.relevanceScore,
  //         reason: l.reason,
  //       })),
  //     },
  //     null,
  //     2,
  //   ),
  // );

  return {
    mapDocument: relevantLinks,
    tokensUsed: totalTokensUsed,
    cost: totalCost,
  };
}
