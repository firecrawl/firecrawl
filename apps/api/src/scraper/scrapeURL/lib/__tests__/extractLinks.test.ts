import { extractLinks } from "../extractLinks";

describe("extractLinks integration", () => {
  it("should resolve relative links with base href correctly", async () => {
    const html = `
      <html>
        <head>
          <base href="/" />
        </head>
        <body>
          <a href="page.php">Page</a>
          <a href="/absolute">Absolute</a>
          <a href="https://external.com">External</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.org/foo/bar");
    expect(links).toContain("https://example.org/page.php");
    expect(links).toContain("https://example.org/absolute");
    expect(links).toContain("https://external.com");
  });

  it("should resolve relative base href against page URL", async () => {
    const html = `
      <html>
        <head>
          <base href="../" />
        </head>
        <body>
          <a href="page.php">Page</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.org/foo/bar");
    expect(links).toContain("https://example.org/page.php");
  });

  it("should handle absolute base href", async () => {
    const html = `
      <html>
        <head>
          <base href="https://cdn.example.com/" />
        </head>
        <body>
          <a href="assets/style.css">CSS</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.org/foo/bar");
    expect(links).toContain("https://cdn.example.com/assets/style.css");
  });

  it("should fallback to page URL when no base href", async () => {
    const html = `
      <html>
        <body>
          <a href="page.php">Page</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.org/foo/bar");
    expect(links).toContain("https://example.org/foo/page.php");
  });

  describe("userinfo and malformed mailto normalization", () => {
    it("strips userinfo from basic auth URLs", async () => {
      const html = `
        <html>
          <body>
            <a href="https://user@example.com/page">Auth link</a>
            <a href="https://user:pass@example.com/other">Auth with pass</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html, "https://example.org/");
      expect(links).toContain("https://example.com/page");
      expect(links).toContain("https://example.com/other");
      expect(links).not.toContain("https://user@example.com/page");
      expect(links).not.toContain("https://user:pass@example.com/other");
    });

    it("normalizes malformed mailto-style URLs", async () => {
      const html = `
        <html>
          <body>
            <a href="https://contact@example.com">Malformed mailto</a>
            <a href="https://support@company.co.uk/page">Support</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html, "https://example.org/");
      expect(links).toContain("https://example.com/");
      expect(links).toContain("https://company.co.uk/page");
    });

    it("strips userinfo when base URL has userinfo", async () => {
      const html = `
        <html>
          <body>
            <a href="page">Relative</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html, "https://user@example.org/foo/");
      expect(links).toContain("https://example.org/foo/page");
      expect(links).not.toContain("https://user@example.org/foo/page");
    });
  });
});
