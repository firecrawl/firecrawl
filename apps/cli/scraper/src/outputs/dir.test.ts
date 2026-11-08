import { describe, expect, it } from "vitest";
import { urlToRelPath } from "./dir.js";

describe("urlToRelPath", () => {
  it("maps a normal article URL to <host>/<path>.<ext>", () => {
    expect(urlToRelPath("https://firecrawl.dev/pricing", ".md")).toBe("firecrawl.dev/pricing.md");
  });

  it("maps a root URL to <host>/index.<ext>", () => {
    expect(urlToRelPath("https://example.com/", ".md")).toBe("example.com/index.md");
    expect(urlToRelPath("https://example.com", ".md")).toBe("example.com/index.md");
  });

  it("appends a stable hash suffix for query strings so distinct queries don't collide", () => {
    const a = urlToRelPath("https://x.io/page?a=1", ".md");
    const b = urlToRelPath("https://x.io/page?a=2", ".md");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^x\.io\/page_[0-9a-f]{6}\.md$/);
    expect(b).toMatch(/^x\.io\/page_[0-9a-f]{6}\.md$/);
  });

  it("produces a filename free of control characters and reserved chars", () => {
    const ctrl = String.fromCharCode(1) + String.fromCharCode(2);
    const url = `https://example.com/foo<bar>${ctrl}baz`;
    const out = urlToRelPath(url, ".md");
    const hasBadChars = [...out].some((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 || '<>"|?*'.includes(c);
    });
    expect(hasBadChars).toBe(false);
    expect(out.startsWith("example.com/")).toBe(true);
    expect(out.endsWith(".md")).toBe(true);
  });

  it("removes trailing dots in segments (Windows-safe)", () => {
    expect(urlToRelPath("https://example.com/dir.../", ".md")).toBe("example.com/dir.md");
  });

  it("falls back to _invalid/<sha>.<ext> for unparseable URLs", () => {
    const out = urlToRelPath("not-a-url", ".md");
    expect(out).toMatch(/^_invalid\/[0-9a-f]{8}\.md$/);
  });
});
