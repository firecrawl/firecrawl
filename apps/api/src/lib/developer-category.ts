/** Strings the search schema accepts and rewrites to the developer category. */
export const developerCategoryAliases = new Set([
  "repo",
  "code",
  "developer",
  "docs",
  "devdex",
  "repo_search",
  "developer_index",
]);

export function isDeveloperCategoryAlias(value: unknown): value is string {
  return typeof value === "string" && developerCategoryAliases.has(value);
}
