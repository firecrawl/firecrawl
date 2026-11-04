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
        // Preserve nested array values; flatten only scalar/object chunk wrappers.
        const items = schema.properties[key].items;
        // Check type constraints throughout intersections before declaring rank.
        // Full schema validation remains the caller's responsibility.
        const permitsArrayType = (item: any): boolean => {
          if (item === true) return true;
          if (!item || typeof item !== "object" || Array.isArray(item))
            return false;
          if (
            item.type !== undefined &&
            item.type !== "array" &&
            !(Array.isArray(item.type) && item.type.includes("array"))
          )
            return false;
          if (Object.hasOwn(item, "const") && !Array.isArray(item.const))
            return false;
          if (
            Array.isArray(item.enum) &&
            !item.enum.some((value: any) => Array.isArray(value))
          )
            return false;
          return (
            [item.anyOf, item.oneOf].every(
              branches =>
                !Array.isArray(branches) || branches.some(permitsArrayType),
            ) &&
            (!Array.isArray(item.allOf) || item.allOf.every(permitsArrayType))
          );
        };
        const allowsArrayValues = (item: any): boolean => {
          if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            !permitsArrayType(item)
          )
            return false;
          return (
            item.type !== undefined ||
            item.items !== undefined ||
            Array.isArray(item.const) ||
            (Array.isArray(item.enum) &&
              item.enum.some((value: any) => Array.isArray(value))) ||
            [item.anyOf, item.oneOf, item.allOf].some(
              branches =>
                Array.isArray(branches) && branches.some(allowsArrayValues),
            )
          );
        };
        const nested = Array.isArray(items)
          ? items.some(allowsArrayValues)
          : allowsArrayValues(items);
        result[key] = nested ? [...multiResult[key]] : multiResult[key].flat();
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
