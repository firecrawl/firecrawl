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
});
