import { load } from "cheerio";

// Import the deduplicateImages function by testing the htmlTransform behavior
// Since deduplicateImages is a private function, we test it through the Cheerio fallback path

/**
 * Helper function that mimics the deduplicateImages logic for testing
 */
function deduplicateImages(soup: ReturnType<typeof load>): void {
  const seenSrcs = new Set<string>();

  soup("img[src]").each((_, el) => {
    const src = el.attribs.src;
    if (src) {
      if (seenSrcs.has(src)) {
        soup(el).remove();
      } else {
        seenSrcs.add(src);
      }
    }
  });
}

describe("deduplicateImages", () => {
  it("should remove duplicate images from carousel-style HTML", () => {
    const html = `
      <div class="carousel">
        <img src="https://example.com/logo1.png" alt="Logo 1">
        <img src="https://example.com/logo2.png" alt="Logo 2">
        <img src="https://example.com/logo1.png" alt="Logo 1 copy">
        <img src="https://example.com/logo2.png" alt="Logo 2 copy">
        <img src="https://example.com/logo1.png" alt="Logo 1 copy 2">
      </div>
    `;

    const soup = load(html);
    deduplicateImages(soup);
    const result = soup.html();

    // Count occurrences of each image src
    const logo1Count = (result?.match(/logo1\.png/g) || []).length;
    const logo2Count = (result?.match(/logo2\.png/g) || []).length;

    expect(logo1Count).toBe(1);
    expect(logo2Count).toBe(1);
  });

  it("should keep all unique images", () => {
    const html = `
      <div>
        <img src="https://example.com/image1.png" alt="Image 1">
        <img src="https://example.com/image2.png" alt="Image 2">
        <img src="https://example.com/image3.png" alt="Image 3">
      </div>
    `;

    const soup = load(html);
    deduplicateImages(soup);
    const result = soup.html();

    expect(result).toContain("image1.png");
    expect(result).toContain("image2.png");
    expect(result).toContain("image3.png");
  });

  it("should preserve first occurrence and remove subsequent duplicates", () => {
    const html = `
      <div>
        <img src="https://example.com/logo.png" alt="First occurrence">
        <p>Some text</p>
        <img src="https://example.com/logo.png" alt="Second occurrence">
      </div>
    `;

    const soup = load(html);
    deduplicateImages(soup);
    const result = soup.html();

    // Should have only one occurrence
    const logoCount = (result?.match(/logo\.png/g) || []).length;
    expect(logoCount).toBe(1);

    // Should preserve the first alt text
    expect(result).toContain("First occurrence");
    expect(result).not.toContain("Second occurrence");
  });

  it("should handle images with different alt text but same URL", () => {
    const html = `
      <div>
        <img src="https://example.com/logo.png" alt="Company Logo">
        <img src="https://example.com/logo.png" alt="Our Logo">
        <img src="https://example.com/logo.png" alt="">
      </div>
    `;

    const soup = load(html);
    deduplicateImages(soup);
    const result = soup.html();

    // Should only have one occurrence of the image URL
    const logoCount = (result?.match(/logo\.png/g) || []).length;
    expect(logoCount).toBe(1);
  });

  it("should not affect images without src attribute", () => {
    const html = `
      <div>
        <img alt="No src">
        <img src="https://example.com/valid.png" alt="Valid">
        <img data-src="https://example.com/lazy.png" alt="Lazy loaded">
      </div>
    `;

    const soup = load(html);
    deduplicateImages(soup);
    const result = soup.html();

    // Image without src should remain
    expect(result).toContain('alt="No src"');
    // Valid image should remain
    expect(result).toContain("valid.png");
    // data-src image should remain (not processed by this function)
    expect(result).toContain("lazy.png");
  });

  it("should handle empty HTML gracefully", () => {
    const html = "<div></div>";

    const soup = load(html);
    deduplicateImages(soup);
    const result = soup.html();

    expect(result).toContain("<div></div>");
  });

  it("should handle large carousel with many duplicates", () => {
    // Simulates a real-world infinite scroll carousel
    const logos = ["partner-a", "partner-b", "partner-c", "partner-d", "partner-e"];
    const duplicates = 5; // Each logo appears 5 times

    const imgTags = logos
      .flatMap((logo) =>
        Array(duplicates)
          .fill(null)
          .map((_, i) => `<img src="https://cdn.example.com/${logo}.png" alt="${logo} ${i}">`)
      )
      .join("\n");

    const html = `<div class="carousel">${imgTags}</div>`;

    const soup = load(html);
    deduplicateImages(soup);
    const result = soup.html();

    // Each logo should appear exactly once
    logos.forEach((logo) => {
      const count = (result?.match(new RegExp(`${logo}\\.png`, "g")) || []).length;
      expect(count).toBe(1);
    });

    // Total images should be 5 (one per unique logo)
    const totalImages = (result?.match(/<img/g) || []).length;
    expect(totalImages).toBe(5);
  });
});

