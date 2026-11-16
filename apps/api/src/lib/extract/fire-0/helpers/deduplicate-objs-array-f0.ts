export function deduplicateObjectsArray_F0(
  objArray: { [key: string]: any[] },
  schema?: any,
): { [key: string]: any[] } {
  const deduplicatedObjArray: { [key: string]: any[] } = {};

  for (const key in objArray) {
    if (Array.isArray(objArray[key])) {
      const seen = new Set();
      deduplicatedObjArray[key] = objArray[key].filter(item => {
        // Matrix rows are positional values unless the schema requires uniqueness.
        if (
          Array.isArray(item) &&
          schema?.properties?.[key] &&
          schema.properties[key].uniqueItems !== true
        ) {
          return true;
        }
        // Create a unique identifier for each item based on its properties
        const identifier = JSON.stringify(item);

        // Check if this identifier has been seen before
        if (seen.has(identifier)) {
          return false; // Duplicate found, filter it out
        }

        // Add the identifier to the set and keep the item
        seen.add(identifier);
        return true;
      });
    } else {
      // If the value is not an array, just copy it as is
      deduplicatedObjArray[key] = objArray[key];
    }
  }

  return deduplicatedObjArray;
}
