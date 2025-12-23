/**
 * Extracts raw XML from HTML-wrapped content that browsers generate when rendering XML files.
 * When browser engines (like Chrome) fetch XML files, they render them as HTML pages with
 * the XML content wrapped in a viewer div. This function detects and extracts the raw XML.
 *
 * @param content - The content that may be HTML-wrapped XML or raw XML
 * @returns The extracted raw XML or the original content if not HTML-wrapped
 */
export function extractXmlFromHtmlWrapper(content: string): string {
  // Only process if content looks like HTML-wrapped XML
  if (
    content.includes("webkit-xml-viewer-source-xml") ||
    (content.startsWith("<!--?xml") && content.includes("<html"))
  ) {
    // Try to extract from WebKit XML viewer div
    const webkitMatch = content.match(
      /<div[^>]*id=["']webkit-xml-viewer-source-xml["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    if (webkitMatch && webkitMatch[1]) {
      const extracted = webkitMatch[1].trim();
      if (
        extracted.includes("<urlset") ||
        extracted.includes("<sitemapindex")
      ) {
        return extracted;
      }
    }

    // Fallback: extract urlset or sitemapindex directly via regex
    const urlsetMatch = content.match(/<urlset[\s\S]*?<\/urlset>/i);
    if (urlsetMatch) return urlsetMatch[0];

    const sitemapIndexMatch = content.match(
      /<sitemapindex[\s\S]*?<\/sitemapindex>/i,
    );
    if (sitemapIndexMatch) return sitemapIndexMatch[0];
  }

  // Return original content if not HTML-wrapped
  return content;
}
