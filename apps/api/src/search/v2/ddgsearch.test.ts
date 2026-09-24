import { cleanUrl } from "./ddgsearch";

// DuckDuckGo's HTML results link through a redirect whose `uddg` query
// parameter holds the percent-encoded target URL.
const ddgRedirect = (target: string) =>
  `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc123`;

describe("cleanUrl", () => {
  it("unwraps a DuckDuckGo redirect to its target URL", () => {
    const target = "https://example.com/docs?q=1";
    expect(cleanUrl(ddgRedirect(target))).toBe(target);
  });

  it("does not throw on a target URL containing a bare percent sign", () => {
    // Regression for #4375: decoding this a second time threw URIError,
    // which aborted the whole results page.
    const target = "https://example.com/100%-off";
    expect(cleanUrl(ddgRedirect(target))).toBe(target);
  });

  it("does not decode percent-escapes that belong to the target URL", () => {
    const targets = [
      "https://example.com/my%20file.pdf",
      "https://example.com/login?next=%2Fhome",
      "https://example.com/sale-100%25-off",
    ];
    for (const target of targets) {
      expect(cleanUrl(ddgRedirect(target))).toBe(target);
    }
  });

  it("returns hrefs that are not DuckDuckGo redirects unchanged", () => {
    const href = "https://example.com/some/page";
    expect(cleanUrl(href)).toBe(href);
  });

  it("returns the href unchanged when uddg is empty", () => {
    const href = "//duckduckgo.com/l/?uddg=&rut=abc123";
    expect(cleanUrl(href)).toBe(href);
  });
});
