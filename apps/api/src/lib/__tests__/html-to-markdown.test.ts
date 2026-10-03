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

describe("parseMarkdown Go parser timeout", () => {
  afterEach(() => {
    vi.doUnmock("koffi");
    vi.doUnmock("fs/promises");
    vi.doUnmock("../../config");
    vi.resetModules();
  });

  // Re-imports the module with the Go parser enabled and its FFI call replaced.
  async function loadWithGoParser(
    timeoutMs: number,
    goAsync: (
      html: string,
      cb: (err: Error | null, res?: string) => void,
    ) => void,
  ) {
    vi.resetModules();
    vi.doMock("koffi", () => ({
      default: {
        load: () => ({
          func: () => ({ async: goAsync }),
        }),
        disposable: () => "CString:mock",
      },
    }));
    vi.doMock("fs/promises", async importOriginal => {
      const orig = await importOriginal<typeof import("fs/promises")>();
      return { ...orig, stat: async () => ({}) as any };
    });
    vi.doMock("../../config", async importOriginal => {
      const orig = await importOriginal<typeof import("../../config")>();
      return {
        ...orig,
        config: {
          ...orig.config,
          USE_GO_MARKDOWN_PARSER: true,
          HTML_TO_MARKDOWN_SERVICE_URL: undefined,
          HTML_TO_MARKDOWN_TIMEOUT_MS: timeoutMs,
        },
      };
    });
    return await import("../html-to-markdown.js");
  }

  it("falls back to turndown instead of hanging when the Go conversion never completes", async () => {
    const { parseMarkdown: parseWithHangingGo } = await loadWithGoParser(
      200,
      () => {
        // never invoke the callback, simulating a hung native conversion
      },
    );
    await expect(parseWithHangingGo("<p>Hello, world!</p>")).resolves.toBe(
      "Hello, world!",
    );
  });

  it("returns the Go parser result when conversion completes within the timeout", async () => {
    const { parseMarkdown: parseWithFastGo } = await loadWithGoParser(
      5000,
      (_html, cb) => cb(null, "go parser output"),
    );
    await expect(parseWithFastGo("<p>Hello, world!</p>")).resolves.toBe(
      "go parser output",
    );
  });
});
