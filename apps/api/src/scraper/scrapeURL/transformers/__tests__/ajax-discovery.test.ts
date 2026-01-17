import { describe, it, expect } from "@jest/globals";

describe("AJAX Discovery - Link Merging Logic", () => {
  it("merges discovered URLs with HTML links", () => {
    // Simulate the logic from deriveLinksFromHTML transformer
    const htmlLinks = [
      "https://example.com/page1",
      "https://example.com/page2",
    ];

    const discoveredUrls = [
      "https://example.com/ajax?year=2015",
      "https://example.com/ajax?year=2014",
    ];

    // Merge logic
    const allLinks = [...htmlLinks];
    if (discoveredUrls?.length) {
      allLinks.push(...discoveredUrls);
    }

    // Deduplicate
    const uniqueLinks = [...new Set(allLinks)];

    expect(uniqueLinks).toHaveLength(4);
    expect(uniqueLinks).toContain("https://example.com/page1");
    expect(uniqueLinks).toContain("https://example.com/page2");
    expect(uniqueLinks).toContain("https://example.com/ajax?year=2015");
    expect(uniqueLinks).toContain("https://example.com/ajax?year=2014");
  });

  it("deduplicates when discovered URLs overlap with HTML links", () => {
    const htmlLinks = [
      "https://example.com/page1",
      "https://example.com/ajax?year=2015",
    ];

    const discoveredUrls = [
      "https://example.com/ajax?year=2015", // duplicate
      "https://example.com/ajax?year=2014",
    ];

    // Merge logic
    const allLinks = [...htmlLinks];
    if (discoveredUrls?.length) {
      allLinks.push(...discoveredUrls);
    }

    // Deduplicate
    const uniqueLinks = [...new Set(allLinks)];

    // Should have 3 unique links, not 4
    expect(uniqueLinks).toHaveLength(3);
    expect(uniqueLinks).toContain("https://example.com/page1");
    expect(uniqueLinks).toContain("https://example.com/ajax?year=2015");
    expect(uniqueLinks).toContain("https://example.com/ajax?year=2014");
  });

  it("handles empty discovered URLs array", () => {
    const htmlLinks = [
      "https://example.com/page1",
      "https://example.com/page2",
    ];

    const discoveredUrls: string[] = [];

    // Merge logic
    const allLinks = [...htmlLinks];
    if (discoveredUrls?.length) {
      allLinks.push(...discoveredUrls);
    }

    // Deduplicate
    const uniqueLinks = [...new Set(allLinks)];

    expect(uniqueLinks).toHaveLength(2);
    expect(uniqueLinks).toEqual(htmlLinks);
  });

  it("handles undefined discovered URLs", () => {
    const htmlLinks = [
      "https://example.com/page1",
      "https://example.com/page2",
    ];

    const discoveredUrls = undefined;

    // Merge logic
    const allLinks = [...htmlLinks];
    if (discoveredUrls?.length) {
      allLinks.push(...discoveredUrls);
    }

    // Deduplicate
    const uniqueLinks = [...new Set(allLinks)];

    expect(uniqueLinks).toHaveLength(2);
    expect(uniqueLinks).toEqual(htmlLinks);
  });

  it("handles empty HTML links with discovered URLs", () => {
    const htmlLinks: string[] = [];

    const discoveredUrls = [
      "https://example.com/ajax?year=2015",
      "https://example.com/ajax?year=2014",
    ];

    // Merge logic
    const allLinks = [...htmlLinks];
    if (discoveredUrls?.length) {
      allLinks.push(...discoveredUrls);
    }

    // Deduplicate
    const uniqueLinks = [...new Set(allLinks)];

    expect(uniqueLinks).toHaveLength(2);
    expect(uniqueLinks).toEqual(discoveredUrls);
  });
});
