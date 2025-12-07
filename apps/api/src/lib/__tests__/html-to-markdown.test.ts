import { parseMarkdown } from "../html-to-markdown";

describe("parseMarkdown", () => {
  it("should correctly convert simple HTML to Markdown", async () => {
    const html = "<p>Hello, world!</p>";
    const expectedMarkdown = "Hello, world!";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should convert complex HTML with nested elements to Markdown", async () => {
    const html =
      "<div><p>Hello <strong>bold</strong> world!</p><ul><li>List item</li></ul></div>";
    const expectedMarkdown = "Hello **bold** world!\n\n- List item";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should return empty string when input is empty", async () => {
    const html = "";
    const expectedMarkdown = "";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should handle null input gracefully", async () => {
    const html = null;
    const expectedMarkdown = "";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should handle various types of invalid HTML gracefully", async () => {
    const invalidHtmls = [
      { html: "<html><p>Unclosed tag", expected: "Unclosed tag" },
      {
        html: "<div><span>Missing closing div",
        expected: "Missing closing div",
      },
      {
        html: "<p><strong>Wrong nesting</em></strong></p>",
        expected: "**Wrong nesting**",
      },
      {
        html: '<a href="http://example.com">Link without closing tag',
        expected: "[Link without closing tag](http://example.com)",
      },
    ];

    for (const { html, expected } of invalidHtmls) {
      await expect(parseMarkdown(html)).resolves.toBe(expected);
    }
  });

  describe("image deduplication", () => {
    it("should deduplicate identical images from carousel-style HTML", async () => {
      // Simulates infinite scroll carousel with duplicated logos
      const html = `
        <div class="carousel">
          <img src="https://example.com/logo1.png" alt="Logo 1">
          <img src="https://example.com/logo2.png" alt="Logo 2">
          <img src="https://example.com/logo1.png" alt="Logo 1">
          <img src="https://example.com/logo2.png" alt="Logo 2">
          <img src="https://example.com/logo1.png" alt="Logo 1">
        </div>
      `;

      const result = await parseMarkdown(html);
      
      // Count occurrences of each image
      const logo1Count = (result.match(/logo1\.png/g) || []).length;
      const logo2Count = (result.match(/logo2\.png/g) || []).length;
      
      expect(logo1Count).toBe(1);
      expect(logo2Count).toBe(1);
    });

    it("should keep unique images intact", async () => {
      const html = `
        <div>
          <img src="https://example.com/image1.png" alt="Image 1">
          <img src="https://example.com/image2.png" alt="Image 2">
          <img src="https://example.com/image3.png" alt="Image 3">
        </div>
      `;

      const result = await parseMarkdown(html);
      
      expect(result).toContain("image1.png");
      expect(result).toContain("image2.png");
      expect(result).toContain("image3.png");
    });

    it("should preserve first occurrence and remove subsequent duplicates", async () => {
      const html = `
        <div>
          <img src="https://example.com/first.png" alt="First occurrence">
          <p>Some text</p>
          <img src="https://example.com/first.png" alt="Second occurrence">
        </div>
      `;

      const result = await parseMarkdown(html);
      
      // Should contain the image once
      const imageCount = (result.match(/first\.png/g) || []).length;
      expect(imageCount).toBe(1);
      
      // Should preserve the alt text from the first occurrence
      expect(result).toContain("First occurrence");
    });

    it("should handle images with different alt text but same URL", async () => {
      const html = `
        <div>
          <img src="https://example.com/logo.png" alt="Company Logo">
          <img src="https://example.com/logo.png" alt="Our Logo">
          <img src="https://example.com/logo.png" alt="">
        </div>
      `;

      const result = await parseMarkdown(html);
      
      // Should only have one occurrence of the image URL
      const logoCount = (result.match(/logo\.png/g) || []).length;
      expect(logoCount).toBe(1);
    });

    it("should not affect regular links", async () => {
      const html = `
        <div>
          <a href="https://example.com/page">Link 1</a>
          <a href="https://example.com/page">Link 2</a>
        </div>
      `;

      const result = await parseMarkdown(html);
      
      // Links should not be deduplicated
      const linkCount = (result.match(/\[Link/g) || []).length;
      expect(linkCount).toBe(2);
    });
  });
});
