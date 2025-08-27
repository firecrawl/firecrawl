import { extractMetadata } from "../../scraper/scrapeURL/lib/extractMetadata";
import { jest, describe, it, expect } from "@jest/globals";

describe("Metadata concatenation", () => {
  it("should concatenate description field into a string while preserving arrays for other metadata fields", async () => {
    const html = `
      <html>
        <head>
          <meta name="description" content="First description">
          <meta name="description" content="Second description">
          <meta property="og:locale:alternate" content="en_US">
          <meta property="og:locale:alternate" content="fr_FR">
          <meta name="keywords" content="first keyword">
          <meta name="keywords" content="second keyword">
        </head>
        <body></body>
      </html>
    `;
    
    const meta: any = {
      url: "https://example.com",
      id: "test-id",
      logger: {
        warn: jest.fn(),
        error: jest.fn()
      }
    };
    
    const metadata = await extractMetadata(meta, html);
    
    expect(metadata.description).toBeDefined();
    expect(Array.isArray(metadata.description)).toBe(false);
    expect(typeof metadata.description).toBe("string");
    expect(metadata.description).toBe("First description, Second description");
    
    expect(metadata.ogLocaleAlternate).toBeDefined();
    expect(Array.isArray(metadata.ogLocaleAlternate)).toBe(true);
    expect(metadata.ogLocaleAlternate).toEqual(["en_US", "fr_FR"]);
    
    expect(metadata.keywords).toBeDefined();
    expect(Array.isArray(metadata.keywords)).toBe(true);
    expect(metadata.keywords).toEqual(["first keyword", "second keyword"]);
  });
});
