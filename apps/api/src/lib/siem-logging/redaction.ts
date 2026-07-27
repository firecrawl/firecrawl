export function withoutAuditMetadata<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const result = { ...(value as Record<string, unknown>) };
  delete result.auditMetadata;
  if (
    result.scrapeOptions &&
    typeof result.scrapeOptions === "object" &&
    !Array.isArray(result.scrapeOptions)
  ) {
    result.scrapeOptions = {
      ...(result.scrapeOptions as Record<string, unknown>),
    };
    delete (result.scrapeOptions as Record<string, unknown>).auditMetadata;
  }
  return result as T;
}
