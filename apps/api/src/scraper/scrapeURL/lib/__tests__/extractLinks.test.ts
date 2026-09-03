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

  it("should filter out mailto: links", async () => {
    const html = `
      <html>
        <body>
          <a href="mailto:test@example.com">Email</a>
          <a href="https://example.com/page">Page</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.com");
    expect(links).not.toContain("mailto:test@example.com");
    expect(links).toContain("https://example.com/page");
  });

  it("should filter out tel: links", async () => {
    const html = `
      <html>
        <body>
          <a href="tel:+1234567890">Call</a>
          <a href="https://example.com/page">Page</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.com");
    expect(links).not.toContain("tel:+1234567890");
    expect(links).toContain("https://example.com/page");
  });

  it("should filter out URLs with basic auth credentials (user:pass@host)", async () => {
    const html = `
      <html>
        <body>
          <a href="https://user:pass@example.com/page">Auth Link</a>
          <a href="https://example.com/page">Normal Link</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.com");
    expect(links).not.toContain("https://user:pass@example.com/page");
    expect(links).toContain("https://example.com/page");
  });

  it("should filter out URLs with userinfo (email@host pattern)", async () => {
    const html = `
      <html>
        <body>
          <a href="https://email@example.com">Malformed mailto</a>
          <a href="https://example.com/contact">Contact</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.com");
    expect(links).not.toContain("https://email@example.com");
    expect(links).not.toContain("https://email@example.com/");
    expect(links).toContain("https://example.com/contact");
  });

  it("should keep valid https URLs without userinfo", async () => {
    const html = `
      <html>
        <body>
          <a href="https://example.com">Home</a>
          <a href="https://sub.example.com/path?q=1">Query</a>
          <a href="http://example.com/page#section">Section</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com");
    expect(links).toContain("https://sub.example.com/path?q=1");
    // Note: fragment links to same page are filtered as section links
  });
});
