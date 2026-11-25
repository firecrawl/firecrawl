import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "winston";
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

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("parseMarkdown Rust dispatch and shadow mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@mendable/firecrawl-rs");
    vi.resetModules();
  });

  async function loadWithMocks(
    env: Record<string, string>,
    rustMock: {
      convertHtmlToMarkdown: ReturnType<typeof vi.fn>;
      postProcessMarkdown?: ReturnType<typeof vi.fn>;
    },
  ) {
    vi.resetModules();
    vi.stubEnv("HTML_TO_MARKDOWN_SERVICE_URL", "");
    vi.stubEnv("USE_GO_MARKDOWN_PARSER", "false");
    vi.stubEnv("RUST_HTML_TO_MD_ENABLED", "false");
    vi.stubEnv("RUST_HTML_TO_MD_SHADOW_RATE", "0");
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    vi.doMock("@mendable/firecrawl-rs", () => ({
      convertHtmlToMarkdown: rustMock.convertHtmlToMarkdown,
      postProcessMarkdown:
        rustMock.postProcessMarkdown ?? vi.fn(async (md: string) => md),
      getInnerJson: vi.fn(),
    }));
    const mod = await import("../html-to-markdown.js");
    return mod.parseMarkdown;
  }

  it("uses Rust converter directly when RUST_HTML_TO_MD_ENABLED is true", async () => {
    const convertHtmlToMarkdown = vi.fn(async () => "rust-markdown");
    const parse = await loadWithMocks(
      { RUST_HTML_TO_MD_ENABLED: "true" },
      { convertHtmlToMarkdown },
    );
    const mockLogger = createMockLogger();

    const out = await parse("<p>Hello</p>", { logger: mockLogger });
    expect(out).toBe("rust-markdown");
    expect(convertHtmlToMarkdown).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("falls back to baseline converter if Rust converter throws", async () => {
    const convertHtmlToMarkdown = vi.fn(async () => {
      throw new Error("native failure");
    });
    const parse = await loadWithMocks(
      { RUST_HTML_TO_MD_ENABLED: "true" },
      { convertHtmlToMarkdown },
    );
    const mockLogger = createMockLogger();

    const out = await parse("<p>Fallback works</p>", { logger: mockLogger });
    expect(out).toBe("Fallback works");
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("skips shadow comparison when zeroDataRetention is true", async () => {
    const convertHtmlToMarkdown = vi.fn(async () => "shadow");
    const parse = await loadWithMocks(
      { RUST_HTML_TO_MD_SHADOW_RATE: "1" },
      { convertHtmlToMarkdown },
    );
    const mockLogger = createMockLogger();

    await parse("<p>Secret</p>", {
      logger: mockLogger,
      zeroDataRetention: true,
    });
    await flushMicrotasks();

    expect(convertHtmlToMarkdown).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("skips shadow comparison when RUST_HTML_TO_MD_SHADOW_RATE is 0", async () => {
    const convertHtmlToMarkdown = vi.fn(async () => "shadow");
    const parse = await loadWithMocks(
      { RUST_HTML_TO_MD_SHADOW_RATE: "0" },
      { convertHtmlToMarkdown },
    );
    const mockLogger = createMockLogger();

    await parse("<p>Normal</p>", { logger: mockLogger });
    await flushMicrotasks();

    expect(convertHtmlToMarkdown).not.toHaveBeenCalled();
  });

  it("measures Markdown link destinations only and logs null byte_ratio on empty baseline", async () => {
    const convertHtmlToMarkdown = vi
      .fn()
      .mockResolvedValueOnce("Plain https://example.com/a without link")
      .mockResolvedValueOnce("Non-empty rust output");
    const parse = await loadWithMocks(
      { RUST_HTML_TO_MD_SHADOW_RATE: "1" },
      { convertHtmlToMarkdown },
    );
    const mockLogger = createMockLogger();

    await parse('<p><a href="https://example.com/a">Link</a></p>', {
      logger: mockLogger,
      requestId: "req-1",
    });
    await flushMicrotasks();

    expect(mockLogger.info).toHaveBeenCalledWith(
      "Rust HTML-to-Markdown shadow comparison",
      expect.objectContaining({
        baseline_engine: "turndown",
        link_recall: 0,
        baseline_link_count: 1,
        rust_link_count: 0,
        request_id: "req-1",
      }),
    );

    mockLogger.info.mockClear();
    await parse("<div></div>", { logger: mockLogger });
    await flushMicrotasks();

    expect(mockLogger.info).toHaveBeenCalledWith(
      "Rust HTML-to-Markdown shadow comparison",
      expect.objectContaining({
        baseline_bytes: 0,
        byte_ratio: null,
      }),
    );
  });

  it("caps concurrent shadow conversions at 4", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const convertHtmlToMarkdown = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolvers.push(resolve);
        }),
    );
    const parse = await loadWithMocks(
      { RUST_HTML_TO_MD_SHADOW_RATE: "1" },
      { convertHtmlToMarkdown },
    );
    const mockLogger = createMockLogger();

    await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        parse(`<p>Item ${idx}</p>`, { logger: mockLogger }),
      ),
    );
    expect(convertHtmlToMarkdown).toHaveBeenCalledTimes(4);

    for (const resolve of resolvers) {
      resolve("done");
    }
    await flushMicrotasks();

    await parse("<p>After drain</p>", { logger: mockLogger });
    expect(convertHtmlToMarkdown).toHaveBeenCalledTimes(5);
  });
});
