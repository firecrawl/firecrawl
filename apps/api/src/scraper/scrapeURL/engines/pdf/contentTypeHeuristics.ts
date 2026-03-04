export function shouldRemovePdfFeatureForContentType(
  contentType: string | null | undefined,
): boolean {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.split(";")[0].trim().toLowerCase();

  // Valid (or ambiguous-but-common) PDF download types should keep PDF parsing enabled.
  if (normalized === "application/pdf") {
    return false;
  }
  if (normalized === "application/octet-stream") {
    return false;
  }

  // HTML/text responses on .pdf URLs are typically embedded viewers or error pages.
  // In this case we should remove the pdf feature and let HTML engines handle it.
  if (normalized.startsWith("text/")) {
    return true;
  }
  if (normalized === "application/xhtml+xml") {
    return true;
  }

  return false;
}
