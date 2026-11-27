import { createLogger } from "winston";
import type { MarkedOptions, parse as markedParse } from "marked";
import { safeMarkdownToHtml } from "../markdownToHtml";

type MarkedModule = {
  parse: typeof markedParse;
};

type ParseFn = (
  src: string,
  options?: MarkedOptions | null,
) => string | Promise<string>;

// Allow a single test to force marked.parse to throw. marked's ESM exports are
// read-only, so we mock the module with a passthrough that delegates to the real
// parse unless a test installs an override.
const markedOverride = vi.hoisted(() => ({
  parse: null as ParseFn | null,
}));
vi.mock("marked", async importOriginal => {
  const actual = await importOriginal<MarkedModule>();
  return {
    ...actual,
    parse: (src: string, options?: MarkedOptions | null) =>
      (markedOverride.parse ?? actual.parse)(src, options),
  };
});

const noopLogger = createLogger({ silent: true });

describe("safeMarkdownToHtml", () => {
  let warnSpy = vi.spyOn(noopLogger, "warn");

  beforeEach(() => {
    warnSpy = vi.spyOn(noopLogger, "warn");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts simple markdown to HTML", async () => {
    const html = await safeMarkdownToHtml("# Hello", noopLogger, "test-1");
    expect(html).toContain("<h1>");
    expect(html).toContain("Hello");
  });

  it("does not throw on pathologically deep or large markdown", async () => {
    // 50,000 nested blockquotes
    const deep = "> ".repeat(50_000) + "content";
    const htmlDeep = await safeMarkdownToHtml(deep, noopLogger, "test-deep");
    expect(typeof htmlDeep).toBe("string");
    expect(htmlDeep.length).toBeGreaterThan(0);

    // ~200KB markdown table
    const row = "| " + "cell | ".repeat(10) + "\n";
    const header = row + "| " + "--- | ".repeat(10) + "\n";
    const table = header + row.repeat(5000);
    expect(table.length).toBeGreaterThan(200_000);

    const htmlTable = await safeMarkdownToHtml(table, noopLogger, "test-table");
    expect(typeof htmlTable).toBe("string");
    expect(htmlTable.length).toBeGreaterThan(0);
  });

  it("falls back to escaped <pre> and logs a warning when marked.parse throws", async () => {
    markedOverride.parse = () => {
      throw new RangeError("Maximum call stack size exceeded");
    };

    try {
      const input = '<script>alert("xss")</script> & "quotes" \'apos\'';
      const html = await safeMarkdownToHtml(input, noopLogger, "test-escape");

      expect(html.startsWith("<pre>")).toBe(true);
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;quotes&quot;");
      expect(html).toContain("&#39;apos&#39;");
      expect(html).not.toContain("<script>");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("marked.parse failed"),
        expect.objectContaining({
          scrapeId: "test-escape",
          markdownLength: expect.any(Number),
        }),
      );
    } finally {
      markedOverride.parse = null;
    }
  });
});
