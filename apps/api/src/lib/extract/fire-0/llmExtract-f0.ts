import { encoding_for_model } from "@dqbd/tiktoken";
import { TiktokenModel } from "@dqbd/tiktoken";
import {
  Document,
  ExtractOptions,
  ExtractOptionsInput,
  TokenUsage,
} from "../../../controllers/v1/types";
import { Logger } from "winston";
import { logger } from "../../../lib/logger";
import { modelPrices } from "../../../lib/extract/usage/model-prices";
import { generateObject, generateText, LanguageModel } from "ai";
import { jsonSchema } from "ai";
import { getModel } from "../../../lib/generic-ai";
import { z } from "zod";

// Get max tokens from model prices
const getModelLimits_F0 = (model: string) => {
  const modelConfig = modelPrices[model];
  if (!modelConfig) {
    // Default fallback values
    return {
      maxInputTokens: 8192,
      maxOutputTokens: 4096,
      maxTokens: 12288,
    };
  }
  return {
    maxInputTokens: modelConfig.max_input_tokens || modelConfig.max_tokens,
    maxOutputTokens: modelConfig.max_output_tokens || modelConfig.max_tokens,
    maxTokens: modelConfig.max_tokens,
  };
};

class LLMRefusalError extends Error {
  public refusal: string;

  constructor(refusal: string) {
    super("LLM refused to extract the website's content");
    this.refusal = refusal;
  }
}

function normalizeSchema(x: any): any {
  if (typeof x !== "object" || x === null) return x;

  if (x["$defs"] !== null && typeof x["$defs"] === "object") {
    x["$defs"] = Object.fromEntries(
      Object.entries(x["$defs"]).map(([name, schema]) => [
        name,
        normalizeSchema(schema),
      ]),
    );
  }

  if (x && x.anyOf) {
    x.anyOf = x.anyOf.map(x => normalizeSchema(x));
  }

  if (x && x.oneOf) {
    x.oneOf = x.oneOf.map(x => normalizeSchema(x));
  }

  if (x && x.allOf) {
    x.allOf = x.allOf.map(x => normalizeSchema(x));
  }

  if (x && x.not) {
    x.not = normalizeSchema(x.not);
  }

  if (x && x.type === "object") {
    return {
      ...x,
      properties: Object.fromEntries(
        Object.entries(x.properties || {}).map(([k, v]) => [
          k,
          normalizeSchema(v),
        ]),
      ),
      required: Object.keys(x.properties || {}),
      additionalProperties: false,
    };
  } else if (x && x.type === "array") {
    return {
      ...x,
      items: normalizeSchema(x.items),
    };
  } else {
    return x;
  }
}

interface TrimResult {
  text: string;
  numTokens: number;
  warning?: string;
}

function trimToTokenLimit_F0(
  text: string,
  maxTokens: number,
  modelId: string = "gpt-4o-mini",
  previousWarning?: string,
): TrimResult {
  try {
    const encoder = encoding_for_model(modelId as TiktokenModel);
    try {
      const tokens = encoder.encode(text);
      const numTokens = tokens.length;

      if (numTokens <= maxTokens) {
        return { text, numTokens };
      }

      const modifier = 3;
      // Start with 3 chars per token estimation
      let currentText = text.slice(0, Math.floor(maxTokens * modifier) - 1);

      // Keep trimming until we're under the token limit
      while (true) {
        const currentTokens = encoder.encode(currentText);
        if (currentTokens.length <= maxTokens) {
          const warning = `The extraction content would have used more tokens (${numTokens}) than the maximum we allow (${maxTokens}). -- the input has been automatically trimmed.`;
          return {
            text: currentText,
            numTokens: currentTokens.length,
            warning: previousWarning
              ? `${warning} ${previousWarning}`
              : warning,
          };
        }
        const overflow = currentTokens.length * modifier - maxTokens - 1;
        // If still over limit, remove another chunk
        currentText = currentText.slice(
          0,
          Math.floor(currentText.length - overflow),
        );
      }
    } catch (e) {
      throw e;
    } finally {
      encoder.free();
    }
  } catch (error) {
    // Fallback to a more conservative character-based approach
    const estimatedCharsPerToken = 2.8;
    const safeLength = maxTokens * estimatedCharsPerToken;
    const trimmedText = text.slice(0, Math.floor(safeLength));

    const warning = `Failed to derive number of LLM tokens the extraction might use -- the input has been automatically trimmed to the maximum number of tokens (${maxTokens}) we support.`;

    return {
      text: trimmedText,
      numTokens: maxTokens, // We assume we hit the max in this fallback case
      warning: previousWarning ? `${warning} ${previousWarning}` : warning,
    };
  }
}

export async function generateCompletions_F0({
  logger,
  options,
  markdown,
  previousWarning,
  isExtractEndpoint,
  model = getModel("gpt-4o-mini"),
  mode = "object",
  metadata,
}: {
  model?: LanguageModel;
  modelName?: string;
  logger: Logger;
  options: ExtractOptionsInput;
  markdown?: string;
  previousWarning?: string;
  isExtractEndpoint?: boolean;
  mode?: "object" | "no-object";
  metadata: {
    teamId: string;
    functionId?: string;
    extractId?: string;
    scrapeId?: string;
  };
}): Promise<{
  extract: any;
  numTokens: number;
  warning: string | undefined;
  totalUsage: TokenUsage;
  model: string;
}> {
  let extract: any;
  let warning: string | undefined;

  if (markdown === undefined) {
    throw new Error("document.markdown is undefined -- this is unexpected");
  }

  const modelId = typeof model === "string" ? model : model.modelId;

  const { maxInputTokens } = getModelLimits_F0(modelId);
  // Calculate 80% of max input tokens (for content)
  const maxTokensSafe = Math.floor(maxInputTokens * 0.8);

  // Use the new trimming function
  const {
    text: trimmedMarkdown,
    numTokens,
    warning: trimWarning,
  } = trimToTokenLimit_F0(markdown, maxTokensSafe, modelId, previousWarning);

  markdown = trimmedMarkdown;
  warning = trimWarning;

  try {
    const prompt =
      options.prompt !== undefined
        ? `Transform the following content into structured JSON output based on the provided schema and this user request: ${options.prompt}. If schema is provided, strictly follow it.\n\n${markdown}`
        : `Transform the following content into structured JSON output based on the provided schema if any.\n\n${markdown}`;

    if (mode === "no-object") {
      const result = await generateText({
        model: model,
        prompt: options.prompt + (markdown ? `\n\nData:${markdown}` : ""),
        temperature: options.temperature ?? 0,
        system: options.systemPrompt,
        providerOptions: {
          google: {
            labels: {
              functionId: metadata.functionId ?? "unspecified",
              extractId: metadata.extractId ?? "unspecified",
              scrapeId: metadata.scrapeId ?? "unspecified",
              teamId: metadata.teamId,
            },
          },
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: metadata.functionId,
          metadata: {
            teamId: metadata.teamId,
            ...(metadata.extractId
              ? {
                  langfuseTraceId: "extract:" + metadata.extractId,
                  extractId: metadata.extractId,
                }
              : {}),
            ...(metadata.scrapeId
              ? {
                  langfuseTraceId: "scrape:" + metadata.scrapeId,
                  scrapeId: metadata.scrapeId,
                }
              : {}),
          },
        },
      });

      extract = result.text;

      return {
        extract,
        warning,
        numTokens,
        totalUsage: {
          promptTokens: numTokens,
          completionTokens: result.usage?.outputTokens ?? 0,
          totalTokens: numTokens + (result.usage?.outputTokens ?? 0),
        },
        model: modelId,
      };
    }

    let schema = options.schema;
    // Normalize the bad json schema users write (mogery)
    if (schema && !(schema instanceof z.ZodType)) {
      // let schema = options.schema;
      if (schema) {
        schema = removeDefaultProperty_F0(schema);
      }

      if (schema && schema.type === "array") {
        schema = {
          type: "object",
          properties: {
            items: options.schema,
          },
          required: ["items"],
          additionalProperties: false,
        };
      } else if (schema && typeof schema === "object" && !schema.type) {
        schema = {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(schema).map(([key, value]) => {
              return [key, removeDefaultProperty_F0(value)];
            }),
          ),
          required: Object.keys(schema),
          additionalProperties: false,
        };
      }

      schema = normalizeSchema(schema);
    }

    const repairConfig = {
      experimental_repairText: async ({ text, error }) => {
        // AI may output a markdown JSON code block. Remove it - mogery
        if (typeof text === "string" && text.trim().startsWith("```")) {
          if (text.trim().startsWith("```json")) {
            text = text.trim().slice("```json".length).trim();
          } else {
            text = text.trim().slice("```".length).trim();
          }

          if (text.trim().endsWith("```")) {
            text = text.trim().slice(0, -"```".length).trim();
          }

          // If this fixes the JSON, just return it. If not, continue - mogery
          try {
            JSON.parse(text);
            return text;
          } catch (_) {}
        }

        const { text: fixedText } = await generateText({
          model: model,
          prompt: `Fix this JSON that had the following error: ${error}\n\nOriginal text:\n${text}\n\nReturn only the fixed JSON, no explanation.`,
          system:
            "You are a JSON repair expert. Your only job is to fix malformed JSON and return valid JSON that matches the original structure and intent as closely as possible. Do not include any explanation or commentary - only return the fixed JSON. Do not return it in a Markdown code block, just plain JSON.",
          providerOptions: {
            google: {
              labels: {
                functionId: metadata.functionId ?? "unspecified",
                extractId: metadata.extractId ?? "unspecified",
                scrapeId: metadata.scrapeId ?? "unspecified",
                teamId: metadata.teamId,
              },
            },
          },
          experimental_telemetry: {
            isEnabled: true,
            functionId: metadata.functionId,
            metadata: {
              teamId: metadata.teamId,
              ...(metadata.extractId
                ? {
                    langfuseTraceId: "extract:" + metadata.extractId,
                    extractId: metadata.extractId,
                  }
                : {}),
              ...(metadata.scrapeId
                ? {
                    langfuseTraceId: "scrape:" + metadata.scrapeId,
                    scrapeId: metadata.scrapeId,
                  }
                : {}),
            },
          },
        });
        return fixedText;
      },
    };

    const generateObjectConfig = {
      model: model,
      prompt: prompt,
      temperature: options.temperature ?? 0,
      system: options.systemPrompt,
      ...(schema && {
        schema: schema instanceof z.ZodType ? schema : jsonSchema(schema),
      }),
      ...(!schema && { output: "no-schema" as const }),
      ...repairConfig,
      ...(!schema && {
        onError: (error: Error) => {
          console.error(error);
        },
      }),
      providerOptions: {
        google: {
          labels: {
            functionId: metadata.functionId ?? "unspecified",
            extractId: metadata.extractId ?? "unspecified",
            scrapeId: metadata.scrapeId ?? "unspecified",
            teamId: metadata.teamId,
          },
        },
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: metadata.functionId,
        metadata: {
          teamId: metadata.teamId,
          ...(metadata.extractId
            ? {
                langfuseTraceId: "extract:" + metadata.extractId,
                extractId: metadata.extractId,
              }
            : {}),
          ...(metadata.scrapeId
            ? {
                langfuseTraceId: "scrape:" + metadata.scrapeId,
                scrapeId: metadata.scrapeId,
              }
            : {}),
        },
      },
    } satisfies Parameters<typeof generateObject>[0];

    const result = await generateObject(generateObjectConfig);
    extract = result.object;

    // If the users actually wants the items object, they can specify it as 'required' in the schema
    // otherwise, we just return the items array
    if (
      options.schema &&
      options.schema.type === "array" &&
      !schema?.required?.includes("items")
    ) {
      extract = extract?.items;
    }

    // Since generateObject doesn't provide token usage, we'll estimate it
    const promptTokens = numTokens;
    const completionTokens = result?.usage?.outputTokens ?? 0;

    return {
      extract,
      warning,
      numTokens,
      totalUsage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: modelId,
    };
  } catch (error) {
    if (error.message?.includes("refused")) {
      throw new LLMRefusalError(error.message);
    }
    throw error;
  }
}

function removeDefaultProperty_F0(schema: any): any {
  if (typeof schema !== "object" || schema === null) return schema;

  const rest = { ...schema };

  // unsupported global keys
  delete rest.default;

  // unsupported object keys
  delete rest.patternProperties;
  delete rest.unevaluatedProperties;
  delete rest.propertyNames;
  delete rest.minProperties;
  delete rest.maxProperties;

  // unsupported string keys
  delete rest.minLength;
  delete rest.maxLength;
  delete rest.pattern;
  delete rest.format;

  // unsupported number keys
  delete rest.minimum;
  delete rest.maximum;
  delete rest.multipleOf;

  // unsupported array keys
  delete rest.unevaluatedItems;
  delete rest.contains;
  delete rest.minContains;
  delete rest.maxContains;
  delete rest.minItems;
  delete rest.maxItems;
  delete rest.uniqueItems;

  for (const key in rest) {
    if (Array.isArray(rest[key])) {
      rest[key] = rest[key].map((item: any) => removeDefaultProperty_F0(item));
    } else if (typeof rest[key] === "object" && rest[key] !== null) {
      rest[key] = removeDefaultProperty_F0(rest[key]);
    }
  }

  return rest;
}

export async function generateSchemaFromPrompt_F0(
  prompt: string,
  metadata: { teamId: string; functionId?: string; extractId?: string },
): Promise<any> {
  const model = getModel("gpt-4o-mini");
  const temperatures = [0, 0.1, 0.3]; // Different temperatures to try
  let lastError: Error | null = null;

  for (const temp of temperatures) {
    try {
      const { extract } = await generateCompletions_F0({
        logger: logger.child({
          method: "generateSchemaFromPrompt/generateCompletions",
        }),
        model: model,
        options: {
          mode: "llm",
          systemPrompt: `You are a schema generator for a web scraping system. Generate a JSON schema based on the user's prompt.
Consider:
1. The type of data being requested
2. Required fields vs optional fields
3. Appropriate data types for each field
4. Nested objects and arrays where appropriate

Valid JSON schema, has to be simple. No crazy properties. OpenAI has to support it.
Supported types
The following types are supported for Structured Outputs:

String
Number
Boolean
Integer
Object
Array
Enum
anyOf

Formats are not supported. Min/max are not supported. Anything beyond the above is not supported. Keep it simple with types and descriptions.
Optionals are not supported.
DO NOT USE FORMATS.
Keep it simple. Don't create too many properties, just the ones that are needed. Don't invent properties.
Return a valid JSON schema object with properties that would capture the information requested in the prompt.`,
          prompt: `Generate a JSON schema for extracting the following information: ${prompt}`,
          temperature: temp,
        },
        markdown: prompt,
        metadata: {
          ...metadata,
          functionId: metadata.functionId
            ? metadata.functionId + "/generateSchemaFromPrompt_F0"
            : "generateSchemaFromPrompt_F0",
        },
      });

      return extract;
    } catch (error) {
      lastError = error as Error;
      logger.warn(`Failed attempt with temperature ${temp}: ${error.message}`);
      continue;
    }
  }

  // If we get here, all attempts failed
  throw new Error(
    `Failed to generate schema after all attempts. Last error: ${lastError?.message}`,
  );
}
