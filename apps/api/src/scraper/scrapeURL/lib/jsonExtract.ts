import type { Logger } from "winston";
import { z } from "zod";
import type { GenerateCompletionsOptions } from "../transformers/llmExtract";
import {
  generateCompletions,
  generateSchemaFromPrompt,
} from "../transformers/llmExtract";
import { CostLimitExceededError } from "../../../lib/cost-tracking";
import { shouldPropagateFromExtraction } from "../../../lib/error";
import { jsonRecordSchema, jsonValueSchema } from "../../../lib/json-types";
import type { JsonObject, JsonValue } from "../../../lib/json-types";
import { JsonExtractionContentTooLargeError } from "../error";
import { toRootSchema, typeIncludes } from "../../../lib/openai-strict-schema";

// ~2MB of markdown, well past typical page sizes -- caps worst-case JSON extraction cost/latency.
export const MAX_JSON_EXTRACTION_MARKDOWN_CHARS = 2_000_000;

const jsonOrRecordSchema = z.union([jsonValueSchema, jsonRecordSchema]);
const jsonArraySchema = z.array(jsonOrRecordSchema.optional());
const jsonRefSchema = z.object({ $ref: z.string() });
const wrappedItemsSchema = z.object({ items: jsonValueSchema });

// Resolve all $defs references in the schema
const resolveRefs = (
  obj: JsonValue | undefined,
  defs: JsonObject,
  logger: Logger,
  visited = new WeakSet<object>(),
  depth = 0,
): JsonValue | undefined => {
  if (!obj || typeof obj !== "object" || depth > 10) {
    return obj;
  }

  if (visited.has(obj)) {
    logger.warn(
      "resolveRefs: Detected circular reference, aborting to prevent infinite recursion",
    );
    return obj;
  }
  visited.add(obj);

  const parsedArray = jsonArraySchema.safeParse(obj);
  if (parsedArray.success) {
    return parsedArray.data.map(item =>
      resolveRefs(item, defs, logger, visited, depth + 1),
    );
  }

  const parsedRef = jsonRefSchema.safeParse(obj);
  if (parsedRef.success) {
    const refPath = parsedRef.data.$ref.split("/");
    if (refPath[0] === "#" && refPath[1] === "$defs") {
      const defName = refPath.at(-1);
      if (defName !== undefined) {
        const parsedDef = jsonRecordSchema.safeParse(defs[defName]);
        if (parsedDef.success) {
          return resolveRefs(
            { ...parsedDef.data },
            defs,
            logger,
            visited,
            depth + 1,
          );
        }
      }
    }
    return obj; // Return original if ref can't be resolved
  }

  const parsedObj = jsonRecordSchema.safeParse(obj);
  if (!parsedObj.success) {
    return obj;
  }

  const resolved: JsonObject = {};
  for (const [key, value] of Object.entries(parsedObj.data)) {
    if (key === "$defs") {
      continue;
    }
    resolved[key] = resolveRefs(value, defs, logger, visited, depth + 1);
  }
  return resolved;
};

// generateCompletions nests a root array schema under an "items" property
// (structured outputs need an object at the root); hand back the array itself.
function unwrapRootArray(
  schema: JsonObject | undefined,
  extract: JsonValue | undefined,
): JsonValue | undefined {
  if (typeIncludes(toRootSchema(schema)?.type, "array")) {
    const parsedExtract = wrappedItemsSchema.safeParse(extract);
    if (parsedExtract.success) {
      return parsedExtract.data.items;
    }
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
  extractedDataArray: Array<JsonValue | undefined>;
  warning: string | undefined;
}> {
  const parsedInitialSchema = jsonOrRecordSchema.safeParse(
    extractOptions.options.schema,
  );
  let schema: JsonValue | undefined = parsedInitialSchema.success
    ? parsedInitialSchema.data
    : undefined;
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
    const parsedGeneratedSchema = jsonOrRecordSchema.safeParse(genRes.extract);
    schema = parsedGeneratedSchema.success
      ? parsedGeneratedSchema.data
      : undefined;
  }

  const parsedSchema = jsonRecordSchema.safeParse(schema);
  if (parsedSchema.success) {
    const schemaObj = parsedSchema.data;
    const parsedDefs = jsonRecordSchema.safeParse(schemaObj.$defs);
    const defs: JsonObject = parsedDefs.success ? parsedDefs.data : {};
    const schemaString = JSON.stringify(schemaObj);
    const hasAnyRefs =
      Boolean(schemaObj.$defs) ||
      schemaString.includes('"$ref"') ||
      schemaString.includes("#/$defs/");

    if (hasAnyRefs) {
      logger.info(
        "Detected schema with references, attempting to resolve refs",
        {
          hasDefsProperty: Boolean(schemaObj.$defs),
          hasRefInString: schemaString.includes('"$ref"'),
          hasRefPathInString: schemaString.includes("#/$defs/"),
        },
      );

      try {
        const resolvedSchema = resolveRefs(schemaObj, defs, logger);

        const resolvedString = JSON.stringify(resolvedSchema);
        const hasRemainingRefs =
          resolvedString.includes('"$ref"') ||
          resolvedString.includes("#/$defs/");

        if (!hasRemainingRefs) {
          const parsedResolved = jsonRecordSchema.safeParse(resolvedSchema);
          if (parsedResolved.success) {
            const cleanedSchema: JsonObject = { ...parsedResolved.data };
            delete cleanedSchema.$defs;
            schema = cleanedSchema;
          } else {
            schema = resolvedSchema;
          }
          logger.info("Successfully resolved schema refs", {
            schema,
          });
        } else {
          logger.info(
            "Reference resolution was skipped or incomplete (remaining $ref detected), preserving original schema",
          );
        }
      } catch (error: unknown) {
        logger.warn(
          "Failed to resolve schema refs, preserving original schema",
          { error },
        );
      }
    } else {
      logger.info("No recursive references detected, resolving refs", {
        schema: schemaObj,
      });
      const resolvedSchema = resolveRefs(schemaObj, defs, logger);
      const parsedResolved = jsonRecordSchema.safeParse(resolvedSchema);
      if (parsedResolved.success) {
        const cleanedSchema: JsonObject = { ...parsedResolved.data };
        delete cleanedSchema.$defs;
        schema = cleanedSchema;
      } else {
        schema = resolvedSchema;
      }
      logger.info("Resolved schema refs", {
        schema,
      });
    }
  }

  const extractOptionsNewSchema: GenerateCompletionsOptions = {
    ...extractOptions,
    options: { ...extractOptions.options, schema },
  };
  logger.info("Generated schema from prompt", {
    schemaToUse: schema,
  });

  let extract: JsonValue | undefined;
  let warning: string | undefined;

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
    const parsedExtract = jsonOrRecordSchema.safeParse(completion.extract);
    extract = parsedExtract.success ? parsedExtract.data : undefined;
    warning = completion.warning;
  } catch (error: unknown) {
    if (
      error instanceof CostLimitExceededError ||
      shouldPropagateFromExtraction(error)
    ) {
      throw error;
    }

    logger.error("failed during jsonExtract.ts:generateCompletions", {
      error,
    });
    // Surface the failure to the caller: swallowing it here made a failed
    // extraction indistinguishable from a successful-but-empty one, so the
    // scrape returned 200 with the json field silently absent (and billed).
    // `warning` is provably undefined here (only assigned on the success
    // path of the try above), so assign directly; the caller merges any
    // pre-existing document warnings.
    const reason = error instanceof Error ? error.message : String(error);
    warning = `JSON extraction failed: ${reason.slice(0, 300)}`;
  }

  const finalSchemaObj = jsonRecordSchema.safeParse(schema);
  return {
    extractedDataArray: [
      unwrapRootArray(
        finalSchemaObj.success ? finalSchemaObj.data : undefined,
        extract,
      ),
    ],
    warning,
  };
}
