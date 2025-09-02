import { embed } from "ai";
import { configDotenv } from "dotenv";
import { getEmbeddingModel } from "./generic-ai";

configDotenv();

async function getEmbedding(
  text: string,
  metadata: { teamId: string; extractId?: string },
) {
  const { embedding } = await embed({
    model: getEmbeddingModel("text-embedding-3-small"),
    value: text,
    experimental_telemetry: {
      isEnabled: true,
      metadata: {
        ...(metadata.extractId
          ? {
              langfuseTraceId: "extract:" + metadata.extractId,
              extractId: metadata.extractId,
            }
          : {}),
        teamId: metadata.teamId,
      },
    },
  });

  return embedding;
}

const cosineSimilarity = (vec1: number[], vec2: number[]): number => {
  const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
  const magnitude1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
  const magnitude2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
  if (magnitude1 === 0 || magnitude2 === 0) return 0;
  return dotProduct / (magnitude1 * magnitude2);
};

// Function to convert text to vector
const textToVector = (searchQuery: string, text: string): number[] => {
  const words = searchQuery.toLowerCase().split(/\W+/);
  return words.map(word => {
    const count = (text.toLowerCase().match(new RegExp(word, "g")) || [])
      .length;
    return count / text.length;
  });
};

async function performRanking(
  linksWithContext: string[],
  links: string[],
  searchQuery: string,
  metadata: { teamId: string; extractId?: string },
) {
  try {
    // Handle invalid inputs
    if (!searchQuery || !linksWithContext.length || !links.length) {
      return [];
    }

    // Sanitize search query by removing null characters
    const sanitizedQuery = searchQuery;

    // Generate embeddings for the search query
    const queryEmbedding = await getEmbedding(sanitizedQuery, metadata);

    // Generate embeddings for each link and calculate similarity in parallel
    const linksAndScores = await Promise.all(
      linksWithContext.map((linkWithContext, index) =>
        getEmbedding(linkWithContext, metadata)
          .then(linkEmbedding => {
            const score = cosineSimilarity(queryEmbedding, linkEmbedding);
            return {
              link: links[index],
              linkWithContext,
              score,
              originalIndex: index,
            };
          })
          .catch(() => ({
            link: links[index],
            linkWithContext,
            score: 0,
            originalIndex: index,
          })),
      ),
    );

    // Sort links based on similarity scores while preserving original order for equal scores
    linksAndScores.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      return scoreDiff === 0 ? a.originalIndex - b.originalIndex : scoreDiff;
    });

    return linksAndScores;
  } catch (error) {
    console.error(`Error performing semantic search: ${error}`);
    return [];
  }
}

export { performRanking };
