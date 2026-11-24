import { Logger } from "winston";
import {
  generateCompletions,
  GenerateCompletionsOptions,
  generateSchemaFromPrompt,
} from "../transformers/llmExtract";
import { TokenUsage } from "../../../controllers/v1/types";
import {
  CostLimitExceededError,
  CostTracking,
} from "../../../lib/cost-tracking";
import {
  JsonExtractionContentTooLargeError,
  UsOnlyUnavailableError,
} from "../error";
import { toRootSchema, typeIncludes } from "../../../lib/openai-strict-schema";

// ~2MB of markdown, well past typical page sizes -- caps worst-case JSON extraction cost/latency.
export const MAX_JSON_EXTRACTION_MARKDOWN_CHARS = 2_000_000;

// Resolve all $defs references in the schema
const resolveRefs = (
  obj: any,
  defs: any,
  logger: Logger,
  visited = new WeakSet(),
  depth = 0,
): any => {
  if (!obj || typeof obj !== "object" || depth > 10) return obj;

  if (visited.has(obj)) {
    logger.warn(
      "resolveRefs: Detected circular reference, aborting to prevent infinite recursion",
    );
    return obj;
  }
  visited.add(obj);

  if (obj.$ref && typeof obj.$ref === "string") {
    // Handle $ref references
    const refPath = obj.$ref.split("/");
    if (refPath[0] === "#" && refPath[1] === "$defs") {
      const defName = refPath[refPath.length - 1];
      if (defs[defName]) {
        return resolveRefs(
          { ...defs[defName] },
          defs,
          logger,
          visited,
          depth + 1,
        );
      }
    }
    return obj; // Return original if ref can't be resolved
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => resolveRefs(item, defs, logger, visited, depth + 1));
  }

  // Handle objects
  const resolved: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$defs") continue;
    resolved[key] = resolveRefs(value, defs, logger, visited, depth + 1);
  }
  return resolved;
};

// generateCompletions nests a root array schema under an "items" property
// (structured outputs need an object at the root); hand back the array itself.
function unwrapRootArray(schema: any, extract: any): any {
  if (
    typeIncludes(toRootSchema(schema)?.type, "array") &&
    extract &&
    typeof extract === "object" &&
    !Array.isArray(extract) &&
    "items" in extract
  ) {
    return extract.items;
  }
  return extract;
}

export async function extractData({
  extractOptions,
  extractId,
  scrapeId,
  metadata,
}: {
  extractOptions: GenerateCompletionsOptions;
  extractId?: string;
  scrapeId?: string;
  metadata: { teamId: string; functionId?: string };
}): Promise<{
  extractedDataArray: any[];
  warning: any;
}> {
  let schema = extractOptions.options.schema;
  const logger = extractOptions.logger;

  if (
    extractOptions.markdown &&
    extractOptions.markdown.length > MAX_JSON_EXTRACTION_MARKDOWN_CHARS
  ) {
    throw new JsonExtractionContentTooLargeError();
  }

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
      extractOptions.zeroDataRetention,
      extractOptions.teamFlags,
    );
    schema = genRes.extract;
  }

  if (schema) {
    const defs = schema.$defs || {};
    const schemaString = JSON.stringify(schema);
    const hasAnyRefs =
      schema.$defs ||
      schemaString.includes('"$ref"') ||
      schemaString.includes("#/$defs/");

    if (hasAnyRefs) {
      logger.info(
        "Detected schema with references, attempting to resolve refs",
        {
          hasDefsProperty: !!schema.$defs,
          hasRefInString: schemaString.includes('"$ref"'),
          hasRefPathInString: schemaString.includes("#/$defs/"),
        },
      );

      try {
        const resolvedSchema = resolveRefs(schema, defs, logger);

        const resolvedString = JSON.stringify(resolvedSchema);
        const hasRemainingRefs =
          resolvedString.includes('"$ref"') ||
          resolvedString.includes("#/$defs/");

        if (!hasRemainingRefs) {
          schema = resolvedSchema;
          if (schema && typeof schema === "object" && schema.$defs)
            delete schema.$defs;
          logger.info("Successfully resolved schema refs", {
            schema,
          });
        } else {
          logger.info(
            "Reference resolution was skipped or incomplete (remaining $ref detected), preserving original schema",
          );
        }
      } catch (error) {
        logger.warn(
          "Failed to resolve schema refs, preserving original schema",
          { error },
        );
      }
    } else {
      logger.info("No recursive references detected, resolving refs", {
        schema,
      });
      schema = resolveRefs(schema, defs, logger);
      delete schema.$defs;
      logger.info("Resolved schema refs", {
        schema,
      });
    }
  }

  const extractOptionsNewSchema = {
    ...extractOptions,
    options: { ...extractOptions.options, schema },
  };
  logger.info("Generated schema from prompt", {
    schemaToUse: schema,
  });

  let extract: any,
    warning: string | undefined,
    totalUsage: TokenUsage | undefined;

  try {
    const completion = await generateCompletions({
      ...extractOptionsNewSchema,
      costTrackingOptions: {
        costTracking: extractOptions.costTrackingOptions.costTracking,
        metadata: {
          module: "scrapeURL",
          method: "extractData",
        },
      },
    });
    extract = completion.extract;
    warning = completion.warning;
    totalUsage = completion.totalUsage;
  } catch (error) {
    if (
      error instanceof CostLimitExceededError ||
      error instanceof UsOnlyUnavailableError
    ) {
      throw error;
    }

    logger.error("failed during jsonExtract.ts:generateCompletions", {
      error,
    });
    // Surface the failure to the caller: swallowing it here made a failed
    // extraction indistinguishable from a successful-but-empty one — the
    // scrape returned 200 with the json field silently absent (and billed).
    // `warning` is provably undefined here (only assigned on the success
    // path of the try above), so assign directly — the caller merges any
    // pre-existing document warnings.
    const reason = error instanceof Error ? error.message : String(error);
    warning = `JSON extraction failed: ${reason.slice(0, 300)}`;
  }

  return {
    extractedDataArray: [unwrapRootArray(schema, extract)],
    warning: warning,
  };
}
