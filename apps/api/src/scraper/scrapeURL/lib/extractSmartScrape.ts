import { Logger } from "winston";
import { z } from "zod";
import {
  generateCompletions,
  GenerateCompletionsOptions,
  generateSchemaFromPrompt,
} from "../transformers/llmExtract";
import { smartScrape } from "./smartScrape";
import { parseMarkdown } from "../../../lib/html-to-markdown";
import { getModel } from "../../../lib/generic-ai";
import { TokenUsage } from "../../../controllers/v1/types";
import type { SmartScrapeResult } from "./smartScrape";
import {
  CostLimitExceededError,
  CostTracking,
} from "../../../lib/cost-tracking";
const commonSmartScrapeProperties = {
  shouldUseSmartscrape: {
    type: "boolean",
    description:
      "Set to `true` if any of the extractedData is null and you think you can find the information by performing user-like interactions (e.g., clicking buttons/accordions to reveal hidden text, login, inputs, pagination etc.). SmartScrape can perform these actions to access the data.",
  },
  // Note: extractedData is added dynamically in prepareSmartScrapeSchema
};

// Define common properties for reasoning and prompt
const commonReasoningPromptProperties = {
  smartscrape_reasoning: {
    type: ["string", "null"],
    // Using the more detailed multi-step description as the common one
    description:
      "Reasoning for why a SmartScrape is needed. Explain which data is missing or requires interaction.",
  },
  smartscrape_prompt: {
    type: ["string", "null"],
    description: `A clear, outcome-focused prompt describing what information to find on the page. 
      Example: "Find the product specifications in the expandable section" rather than "Click the button to reveal product specs".
      Used by the smart scraping agent to determine what actions to take.
      Dont mention anything about extraction, smartscrape just returns page content.`,
  },
};

// Schema for single-step SmartScrape interaction
const smartScrapeWrapperSchemaDefinition = {
  type: "object",
  properties: {
    ...commonSmartScrapeProperties, // Include shared base properties
    ...commonReasoningPromptProperties, // Include shared reasoning/prompt properties
    // extractedData will be added dynamically
  },
  additionalProperties: false,
  required: ["extractedData", "shouldUseSmartscrape"],
};

// Schema for multi-step SmartScrape interaction
const multiSmartScrapeWrapperSchemaDefinition = {
  type: "object",
  properties: {
    ...commonSmartScrapeProperties, // Include shared base properties
    smartScrapePages: {
      type: "array",
      description:
        "Make an entry for each page we want to run smart scrape on, no matter how many actions it should be one entry per page.",
      items: {
        type: "object",
        properties: {
          page_index: {
            // Specific to items within the array
            type: "number",
            description: "The index of the page in the SmartScrape process.",
          },
          ...commonReasoningPromptProperties, // Include shared reasoning/prompt properties here too
        },
        // required: ["page_index", "smartscrape_reasoning", "smartscrape_prompt"], // If needed per step
        // additionalProperties: false,
      },
    },
    // extractedData will be added dynamically
  },
  additionalProperties: false,
  required: ["extractedData", "shouldUseSmartscrape"],
};

//TODO: go over and check
// should add null to all types
// type:string should be type:["string","null"]
export function makeSchemaNullable(schema: any): any {
  if (typeof schema !== "object" || schema === null) {
    return schema; // Base case: not an object/array or is null
  }

  if (Array.isArray(schema)) {
    return schema.map(makeSchemaNullable); // Recurse for array items
  }

  // Process object properties
  const newSchema: { [key: string]: any } = {};
  let isObject = false; // Flag to track if this level is an object type

  for (const key in schema) {
    if (key === "additionalProperties") {
      continue; // Skip existing additionalProperties, we'll set it later if needed
    }

    if (key === "type") {
      const currentType = schema[key];
      let finalType: string | string[];

      if (typeof currentType === "string") {
        if (currentType === "object") isObject = true;
        finalType =
          currentType === "null" ? currentType : [currentType, "null"];
      } else if (Array.isArray(currentType)) {
        if (currentType.includes("object")) isObject = true;
        finalType = currentType.includes("null")
          ? currentType
          : [...currentType, "null"];
      } else {
        finalType = currentType; // Handle unexpected types?
      }
      newSchema[key] = finalType;
    } else if (typeof schema[key] === "object" && schema[key] !== null) {
      // Recurse for nested objects (properties, items, definitions, etc.)
      newSchema[key] = makeSchemaNullable(schema[key]);
      if (key === "properties") {
        // Having a 'properties' key strongly implies an object type
        isObject = true;
      }
    } else {
      // Copy other properties directly (like required, description, etc.)
      newSchema[key] = schema[key];
    }
  }

  // **Crucial Fix:** If this schema represents an object type, add additionalProperties: false
  if (isObject) {
    // Ensure 'properties' exists if 'type' was 'object' but 'properties' wasn't defined
    if (!newSchema.properties) {
      newSchema.properties = {};
    }
    newSchema.additionalProperties = false;
  }

  return newSchema;
}

/**
 * Wraps the original schema with SmartScrape fields if an original schema exists.
 *
 * @param originalSchema The user-provided schema (JSON Schema object or Zod schema).
 * @param logger Winston logger instance.
 * @returns An object containing the schema to use for the LLM call and whether wrapping occurred.
 */
export function prepareSmartScrapeSchema(
  originalSchema: any | z.ZodTypeAny | undefined,
  logger: Logger,
  isSingleUrl: boolean,
) {
  // Make the user's schema nullable *and* ensure nested objects have additionalProperties:false
  const nullableAndStrictSchema = originalSchema;

  let smartScrapeWrapScehma;
  if (isSingleUrl) {
    smartScrapeWrapScehma = smartScrapeWrapperSchemaDefinition;
  } else {
    smartScrapeWrapScehma = multiSmartScrapeWrapperSchemaDefinition;
  }

  const wrappedSchema = {
    ...smartScrapeWrapScehma, // Uses the wrapper defined above
    properties: {
      extractedData: nullableAndStrictSchema, // Nest the modified original schema
      ...smartScrapeWrapScehma.properties, // Add smartscrape fields
    },
    // required is inherited from smartScrapeWrapperSchemaDefinition
    // additionalProperties:false is inherited from smartScrapeWrapperSchemaDefinition for the top level
  };

  logger.info("Wrapping original schema with SmartScrape fields.", {
    // Limit logging potentially large schemas
    wrappedSchemaKeys: Object.keys(wrappedSchema.properties),
  });
  return { schemaToUse: wrappedSchema };
}

// Resolve all $defs references in the schema
const resolveRefs = (obj: any, defs: any): any => {
  if (!obj || typeof obj !== "object") return obj;

  if (obj.$ref && typeof obj.$ref === "string") {
    // Handle $ref references
    const refPath = obj.$ref.split("/");
    if (refPath[0] === "#" && refPath[1] === "$defs") {
      const defName = refPath[refPath.length - 1];
      return resolveRefs({ ...defs[defName] }, defs);
    }
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => resolveRefs(item, defs));
  }

  // Handle objects
  const resolved: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$defs") continue;
    resolved[key] = resolveRefs(value, defs);
  }
  return resolved;
};

export async function extractData({
  extractOptions,
  urls,
  useAgent,
  extractId,
  sessionId,
  scrapeId,
  metadata,
}: {
  extractOptions: GenerateCompletionsOptions;
  urls: string[];
  useAgent: boolean;
  extractId?: string;
  sessionId?: string;
  scrapeId?: string;
  metadata: { teamId: string; functionId?: string };
}): Promise<{
  extractedDataArray: any[];
  warning: any;
  costLimitExceededTokenUsage: number | null;
}> {
  let schema = extractOptions.options.schema;
  const logger = extractOptions.logger;
  const isSingleUrl = urls.length === 1;
  let costLimitExceededTokenUsage: number | null = null;
  // TODO: remove the "required" fields here!! it breaks o3-mini

  if (!schema && extractOptions.options.prompt) {
    const genRes = await generateSchemaFromPrompt(
      extractOptions.options.prompt,
      logger,
      extractOptions.costTrackingOptions.costTracking,
      {
        ...metadata,
        extractId,
        scrapeId,
        functionId: metadata.functionId
          ? metadata.functionId + "/extractData"
          : "extractData",
      },
    );
    schema = genRes.extract;
  }

  if (schema) {
    const defs = schema.$defs || {};
    schema = resolveRefs(schema, defs);
    delete schema.$defs;
    logger.info("Resolved schema refs", {
      schema,
    });
  }

  const { schemaToUse } = prepareSmartScrapeSchema(schema, logger, isSingleUrl);
  const extractOptionsNewSchema = {
    ...extractOptions,
    options: { ...extractOptions.options, schema: schemaToUse },
  };
  // console.log("schema", schema);
  // console.log("schemaToUse", schemaToUse);
  logger.info("Generated schema from prompt", {
    schemaToUse,
  });

  let extract: any,
    warning: string | undefined,
    totalUsage: TokenUsage | undefined;

  // checks if using smartScrape is needed for this case
  try {
    const {
      extract: e,
      warning: w,
      totalUsage: t,
    } = await generateCompletions({
      ...extractOptionsNewSchema,
      costTrackingOptions: {
        costTracking: extractOptions.costTrackingOptions.costTracking,
        metadata: {
          module: "scrapeURL",
          method: "extractData",
          description: "Check if using smartScrape is needed for this case",
        },
      },
    });
    extract = e;
    warning = w;
    totalUsage = t;
  } catch (error) {
    if (error instanceof CostLimitExceededError) {
      throw error;
    }

    logger.error("failed during extractSmartScrape.ts:generateCompletions", {
      error,
    });
    // console.log("failed during extractSmartScrape.ts:generateCompletions", error);
  }

  let extractedData = extract?.extractedData;

  // console.log("shouldUseSmartscrape", extract?.shouldUseSmartscrape);
  // console.log("smartscrape_reasoning", extract?.smartscrape_reasoning);
  // console.log("smartscrape_prompt", extract?.smartscrape_prompt);
  try {
    logger.info("Smart schema resolved", {
      useAgent,
      shouldUseSmartscrape: extract?.shouldUseSmartscrape,
      url: urls,
      prompt: extract?.smartscrape_prompt,
      providedExtractId: extractId,
    });

    if (useAgent && extract?.shouldUseSmartscrape) {
      let smartscrapeResults: SmartScrapeResult[];
      if (isSingleUrl) {
        smartscrapeResults = [
          await smartScrape({
            url: urls[0],
            prompt: extract?.smartscrape_prompt,
            sessionId,
            extractId,
            scrapeId,
            costTracking: extractOptions.costTrackingOptions.costTracking,
          }),
        ];
      } else {
        const pages = extract?.smartscrapePages ?? [];
        //do it async promiseall instead
        if (pages.length > 100) {
          logger.warn(
            "Smart scrape pages limit exceeded, only first 100 pages will be scraped",
            {
              pagesLength: pages.length,
              extractId,
              scrapeId,
            },
          );
        }

        smartscrapeResults = await Promise.all(
          pages.slice(0, 100).map(async page => {
            return await smartScrape({
              url: urls[page.page_index],
              prompt: page.smartscrape_prompt,
              sessionId,
              extractId,
              scrapeId,
              costTracking: extractOptions.costTrackingOptions.costTracking,
            });
          }),
        );
      }
      // console.log("smartscrapeResults", smartscrapeResults);

      const scrapedPages = smartscrapeResults.map(
        result => result.scrapedPages,
      );
      // console.log("scrapedPages", scrapedPages);
      const htmls = scrapedPages.flat().map(page => page.html);
      // console.log("htmls", htmls);
      const markdowns = await Promise.all(
        htmls.map(async html => await parseMarkdown(html)),
      );
      // console.log("markdowns", markdowns);
      extractedData = await Promise.all(
        markdowns.map(async markdown => {
          const newExtractOptions = {
            ...extractOptions,
            markdown: markdown,
            model: getModel("gemini-2.5-pro", "vertex"),
            retryModel: getModel("gemini-2.5-pro", "google"),
            costTrackingOptions: {
              costTracking: extractOptions.costTrackingOptions.costTracking,
              metadata: {
                module: "scrapeURL",
                method: "extractData",
                description: "Extract data from markdown (smart-scape results)",
              },
            },
          };
          const { extract } = await generateCompletions(newExtractOptions);
          return extract;
        }),
      );

      // console.log("markdowns", markdowns);
      // extractedData = smartscrapeResult;
    } else {
      extractedData = [extractedData];
    }
  } catch (error) {
    console.error(">>>>>>>extractSmartScrape.ts error>>>>>\n", error);
    if (error instanceof Error && error.message === "Cost limit exceeded") {
      costLimitExceededTokenUsage = (error as any).cause.tokenUsage;
      warning =
        "Smart scrape cost limit exceeded." + (warning ? " " + warning : "");
    } else {
      throw error;
    }
  }

  return {
    extractedDataArray: extractedData,
    warning: warning,
    costLimitExceededTokenUsage: costLimitExceededTokenUsage,
  };
}
