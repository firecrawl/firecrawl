export function isSuccessfulScrapedResult(result: any): boolean {
  const statusCode = result.metadata?.statusCode;
  if (
    typeof statusCode === "number" &&
    (statusCode < 200 || statusCode >= 400)
  ) {
    return false;
  }
  if (result.metadata?.error) return false;
  return (
    typeof statusCode === "number" ||
    Boolean(result.markdown || result.html || result.rawHtml)
  );
}
