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

  it("should leave out javascript: pseudo-links", async () => {
    const html = `
      <html>
        <body>
          <a href="javascript:void(0)">Menu</a>
          <a href="JavaScript:openChat()">Chat</a>
          <a href=" java	script:;">Spaced</a>
          <a href="/pricing">Pricing</a>
          <a href="mailto:sales@example.org">Mail</a>
        </body>
      </html>
    `;
    const links = await extractLinks(html, "https://example.org/");
    expect(links).toEqual([
      "https://example.org/pricing",
      "mailto:sales@example.org",
    ]);
  });

  it("should leave out javascript: pseudo-links in Markdown", async () => {
    const markdown = [
      "[Menu](javascript:void(0)) and [Pricing](/pricing).",
      "",
      "<javascript:openChat()> and [chat][].",
      "",
      "[chat]: JavaScript:openChat()",
    ].join("\n");
    const links = await extractLinks(
      markdown,
      "https://example.org/",
      "text/markdown",
    );
    expect(links).toEqual(["https://example.org/pricing"]);
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
});
