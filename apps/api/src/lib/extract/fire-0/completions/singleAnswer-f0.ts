import { logger } from "../../../../lib/logger";
import { generateCompletions_F0 } from "../llmExtract-f0";
import { buildDocument_F0 } from "../build-document-f0";
import { Document, TokenUsage } from "../../../../controllers/v1/types";

export async function singleAnswerCompletion_F0({
  singleAnswerDocs,
  rSchema,
  links,
  prompt,
  systemPrompt,
  metadata,
}: {
  singleAnswerDocs: Document[];
  rSchema: any;
  links: string[];
  prompt: string;
  systemPrompt: string;
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
  };
}): Promise<{
  extract: any;
  tokenUsage: TokenUsage;
  sources: string[];
}> {
  const completion = await generateCompletions_F0({
    logger: logger.child({ module: "extract", method: "generateCompletions" }),
    options: {
      mode: "llm",
      systemPrompt:
        (systemPrompt ? `${systemPrompt}\n` : "") +
        "Always prioritize using the provided content to answer the question. Do not make up an answer. Do not hallucinate. In case you can't find the information and the string is required, instead of 'N/A' or 'Not speficied', return an empty string: '', if it's not a string and you can't find the information, return null. Be concise and follow the schema always if provided. Here are the urls the user provided of which he wants to extract information from: " +
        links.join(", "),
      prompt: "Today is: " + new Date().toISOString() + "\n" + prompt,
      schema: rSchema,
    },
    markdown: singleAnswerDocs.map(x => buildDocument_F0(x)).join("\n"),
    isExtractEndpoint: true,
    metadata: {
      ...metadata,
      functionId: metadata.functionId
        ? metadata.functionId + "/singleAnswerCompletion_F0"
        : "singleAnswerCompletion_F0",
    },
  });
  return {
    extract: completion.extract,
    tokenUsage: completion.totalUsage,
    sources: singleAnswerDocs.map(
      doc => doc.metadata.url || doc.metadata.sourceURL || "",
    ),
  };
}
