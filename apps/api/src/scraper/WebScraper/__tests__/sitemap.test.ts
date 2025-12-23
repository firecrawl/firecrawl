// Test the extractXmlFromHtmlWrapper function in isolation
// We inline the function here to avoid importing the full sitemap module
// which has complex dependencies that Jest can't handle

/**
 * Extracts raw XML from HTML-wrapped content that browsers generate when rendering XML files.
 */
function extractXmlFromHtmlWrapper(content: string): string {
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

describe("extractXmlFromHtmlWrapper", () => {
  describe("when content is raw XML", () => {
    it("returns raw XML urlset unchanged", () => {
      const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
  </url>
</urlset>`;
      expect(extractXmlFromHtmlWrapper(rawXml)).toBe(rawXml);
    });

    it("returns raw XML sitemapindex unchanged", () => {
      const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
</sitemapindex>`;
      expect(extractXmlFromHtmlWrapper(rawXml)).toBe(rawXml);
    });
  });

  describe("when content is WebKit HTML-wrapped XML", () => {
    it("extracts urlset from WebKit XML viewer wrapper", () => {
      const wrappedXml = `<!--?xml version="1.0" encoding="UTF-8"?--><html><head></head><body><div id="webkit-xml-viewer-source-xml"><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
</urlset></div></body></html>`;

      const result = extractXmlFromHtmlWrapper(wrappedXml);
      expect(result).toContain("<urlset");
      expect(result).toContain("https://example.com/page1");
      expect(result).not.toContain("<html>");
      expect(result).not.toContain("webkit-xml-viewer");
    });

    it("extracts sitemapindex from WebKit XML viewer wrapper", () => {
      const wrappedXml = `<!--?xml version="1.0" encoding="UTF-8"?--><html><head></head><body><div id="webkit-xml-viewer-source-xml"><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
</sitemapindex></div></body></html>`;

      const result = extractXmlFromHtmlWrapper(wrappedXml);
      expect(result).toContain("<sitemapindex");
      expect(result).toContain("https://example.com/sitemap1.xml");
      expect(result).not.toContain("<html>");
    });

    it("handles single quotes in webkit div id", () => {
      const wrappedXml = `<!--?xml version="1.0"?--><html><body><div id='webkit-xml-viewer-source-xml'><urlset><url><loc>https://example.com/</loc></url></urlset></div></body></html>`;

      const result = extractXmlFromHtmlWrapper(wrappedXml);
      expect(result).toContain("<urlset>");
      expect(result).not.toContain("<html>");
    });
  });

  describe("when WebKit extraction fails, uses fallback regex", () => {
    it("extracts urlset via fallback when webkit div structure is different", () => {
      const wrappedXml = `<!--?xml version="1.0"?--><html><body><div class="some-other-wrapper"><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/fallback</loc>
  </url>
</urlset></div></body></html>`;

      const result = extractXmlFromHtmlWrapper(wrappedXml);
      expect(result).toContain("<urlset");
      expect(result).toContain("https://example.com/fallback");
    });

    it("extracts sitemapindex via fallback", () => {
      const wrappedXml = `<!--?xml version="1.0"?--><html><body><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap.xml</loc>
  </sitemap>
</sitemapindex></body></html>`;

      const result = extractXmlFromHtmlWrapper(wrappedXml);
      expect(result).toContain("<sitemapindex");
      expect(result).toContain("https://example.com/sitemap.xml");
    });
  });

  describe("edge cases", () => {
    it("returns empty string unchanged", () => {
      expect(extractXmlFromHtmlWrapper("")).toBe("");
    });

    it("returns non-XML HTML unchanged", () => {
      const html = `<!DOCTYPE html><html><body><h1>Hello World</h1></body></html>`;
      expect(extractXmlFromHtmlWrapper(html)).toBe(html);
    });

    it("handles content with webkit-xml-viewer-source-xml text but no actual wrapper", () => {
      // This is an edge case where the string appears but isn't in a proper div
      const content = `Some text mentioning webkit-xml-viewer-source-xml but not actually wrapped`;
      // Should return original since no urlset/sitemapindex can be extracted
      expect(extractXmlFromHtmlWrapper(content)).toBe(content);
    });

    it("handles malformed XML gracefully", () => {
      const malformed = `<!--?xml version="1.0"?--><html><body><div id="webkit-xml-viewer-source-xml"><broken>not valid sitemap</broken></div></body></html>`;
      // Should return original since no urlset/sitemapindex found
      expect(extractXmlFromHtmlWrapper(malformed)).toBe(malformed);
    });
  });
});
