import { MapDocument, URLTrace } from "../../../controllers/v1/types";
import { logger } from "../../logger";
import { generateCompletions } from "../../../scraper/scrapeURL/transformers/llmExtract";
import {
  buildRerankerSystemPrompt_F0,
  buildRerankerUserPrompt_F0,
} from "./build-prompts-f0";
import { CostTracking } from "../../cost-tracking";

type RerankerResult = {
  mapDocument: (MapDocument & { relevanceScore?: number; reason?: string })[];
  tokensUsed: number;
};

type RerankerOptions = {
  links: MapDocument[];
  searchQuery: string;
  urlTraces: URLTrace[];
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
  };
};

export async function rerankLinksWithLLM_F0(
  options: RerankerOptions,
  costTracking: CostTracking,
): Promise<RerankerResult> {
  const { links, searchQuery, urlTraces, metadata } = options;
  const chunkSize = 100;
  const chunks: MapDocument[][] = [];
  const TIMEOUT_MS = 20000;
  const MAX_RETRIES = 2;
  let totalTokensUsed = 0;

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

  const results = await Promise.all(
    chunks.map(async (chunk, chunkIndex) => {
      // console.log(`Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length} links`);

      const linksContent = chunk
        .map(
          link =>
            `URL: ${link.url}${link.title ? `\nTitle: ${link.title}` : ""}${link.description ? `\nDescription: ${link.description}` : ""}`,
        )
        .join("\n\n");

      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          let timeoutHandle: NodeJS.Timeout;
          const timeoutPromise = new Promise<null>(resolve => {
            timeoutHandle = setTimeout(() => resolve(null), TIMEOUT_MS);
          });

          // dumpToFile(new Date().toISOString(),[buildRerankerSystemPrompt(), buildRerankerUserPrompt(searchQuery), schema, linksContent])
          const completionPromise = generateCompletions({
            logger: logger.child({
              method: "rerankLinksWithLLM",
              chunk: chunkIndex + 1,
              retry,
            }),
            options: {
              systemPrompt: buildRerankerSystemPrompt_F0(),
              prompt: buildRerankerUserPrompt_F0(searchQuery),
              schema: schema,
            },
            markdown: linksContent,
            isExtractEndpoint: true,
            costTrackingOptions: {
              costTracking: new CostTracking(),
              metadata: {
                module: "extract",
                method: "rerankLinksWithLLM",
              },
            },
            metadata: {
              ...metadata,
              functionId: metadata.functionId
                ? metadata.functionId + "/rerankLinksWithLLM_F0"
                : "rerankLinksWithLLM_F0",
            },
          });

          const completion = await Promise.race([
            completionPromise,
            timeoutPromise,
          ]).finally(() => {
            clearTimeout(timeoutHandle);
          });

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

  // Map back to MapDocument format, keeping only relevant links
  const relevantLinks = flattenedResults
    .map(result => {
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
      return undefined;
    })
    .filter((link): link is NonNullable<typeof link> => link !== undefined);

  return {
    mapDocument: relevantLinks,
    tokensUsed: totalTokensUsed,
  };
}
