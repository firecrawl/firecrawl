import type { Logger } from "winston";

export async function mixSchemaObjects(
  finalSchema: any,
  singleAnswerResult: any,
  multiEntityResult: any,
  logger?: Logger,
) {
  const finalResult: any = {};
  logger?.debug("Mixing schema objects.");

  // Recursive helper function to merge results based on schema
  function mergeResults(schema: any, singleResult: any, multiResult: any) {
    const result: any = {};
    for (const key in schema.properties) {
      if (
        schema.properties[key].type === "object" &&
        schema.properties[key].properties
      ) {
        // If the property is an object, recursively merge its properties
        result[key] = mergeResults(
          schema.properties[key],
          singleResult[key] || {},
          multiResult[key] || {},
        );
      } else if (
        schema.properties[key].type === "array" &&
        Array.isArray(multiResult[key])
      ) {
        // If the property is an array, flatten the arrays from multiResult
        result[key] = multiResult[key].flat();
      } else if (singleResult.hasOwnProperty(key)) {
        result[key] = singleResult[key];
      } else if (multiResult.hasOwnProperty(key)) {
        result[key] = multiResult[key];
      }
    }
    return result;
  }

  // Merge the properties from the final schema
  Object.assign(
    finalResult,
    mergeResults(finalSchema, singleAnswerResult, multiEntityResult),
  );

  return finalResult;
}
