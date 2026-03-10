import {
  extractLinks,
  extractMetadata,
  transformHtml,
  TransformHtmlOptions,
} from "@mendable/firecrawl-rs";

describe("HTML Transformer", () => {
  describe("extractLinks", () => {
    it("should return empty array for null or undefined input", async () => {
      expect(await extractLinks(null)).toEqual([]);
      expect(await extractLinks(undefined)).toEqual([]);
    });

    it("should extract links from HTML content", async () => {
      const html = `
        <html>
          <body>
            <a href="https://example.com">Example</a>
            <a href="https://test.com">Test</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html);
      expect(links).toContain("https://example.com");
      expect(links).toContain("https://test.com");
    });

    it("should handle relative links", async () => {
      const html = `
        <html>
          <body>
            <a href="/path/to/page">Relative</a>
            <a href="../another/page">Parent Path</a>
            <a href="./local/page">Local Path</a>
            <a href="relative/path">Implicit Relative</a>
            <a href="?param=value">Query Param</a>
            <a href="#section">Hash Link</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html);
      expect(links).toEqual([
        "/path/to/page",
        "../another/page",
        "./local/page",
        "relative/path",
        "?param=value",
        "#section",
      ]);
    });

    it("should handle complex nested HTML structure", async () => {
      const html = `
        <html>
          <body>
            <div class="container">
              <nav>
                <ul>
                  <li><a href="https://nav1.com">Nav 1</a></li>
                  <li><a href="https://nav2.com">Nav 2</a></li>
                </ul>
              </nav>
              <main>
                <article>
                  <p>Some text with a <a href="https://inline.com">link</a></p>
                  <div class="nested">
                    <a href="https://nested.com">Nested Link</a>
                  </div>
                </article>
              </main>
            </div>
          </body>
        </html>
      `;
      const links = await extractLinks(html);
      expect(links).toContain("https://nav1.com");
      expect(links).toContain("https://nav2.com");
      expect(links).toContain("https://inline.com");
      expect(links).toContain("https://nested.com");
    });

    it("should handle malformed HTML gracefully", async () => {
      const html = `
        <div>
          <a href="https://valid.com">Valid</a>
          <a href="invalid">Invalid</a>
          <a>No href</a>
          <a href="">Empty href</a>
          <a href="javascript:void(0)">JavaScript href</a>
          <a href="mailto:test@example.com">Email link</a>
        </div>
      `;
      const links = await extractLinks(html);
      expect(links).toContain("https://valid.com");
      // Other links should be filtered out or handled appropriately
    });

    it("should handle base href for relative links", async () => {
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
      const links = await extractLinks(html);
      expect(links).toContain("page.php");
      expect(links).toContain("/absolute");
      expect(links).toContain("https://external.com");
    });

    it("should handle relative base href", async () => {
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
      const links = await extractLinks(html);
      expect(links).toContain("page.php");
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
      const links = await extractLinks(html);
      expect(links).toContain("assets/style.css");
    });

    it("should use first base href when multiple exist", async () => {
      const html = `
        <html>
          <head>
            <base href="/" />
            <base href="/other/" />
          </head>
          <body>
            <a href="page.php">Page</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html);
      expect(links).toContain("page.php");
    });

    it("should fallback to page URL when no base href", async () => {
      const html = `
        <html>
          <body>
            <a href="page.php">Page</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html);
      expect(links).toContain("page.php");
    });

    it("should handle malformed base href gracefully", async () => {
      const html = `
        <html>
          <head>
            <base href="" />
            <base />
          </head>
          <body>
            <a href="page.php">Page</a>
          </body>
        </html>
      `;
      const links = await extractLinks(html);
      expect(links).toContain("page.php");
    });
  });

  describe("extractMetadata", () => {
    it("should return empty object for null or undefined input", async () => {
      expect(await extractMetadata(null)).toEqual({});
      expect(await extractMetadata(undefined)).toEqual({});
    });

    it("should extract comprehensive metadata from HTML content", async () => {
      const html = `
        <html>
          <head>
            <title>Test Page Title</title>
            <meta name="description" content="Detailed page description">
            <meta name="keywords" content="test,page,keywords">
            <meta name="author" content="Test Author">
            <meta property="og:title" content="OpenGraph Title">
            <meta property="og:description" content="OpenGraph Description">
            <meta property="og:image" content="https://example.com/image.jpg">
            <meta name="twitter:card" content="summary">
            <meta name="twitter:title" content="Twitter Title">
            <link rel="canonical" href="https://example.com/canonical">
          </head>
          <body></body>
        </html>
      `;
      const metadata = await extractMetadata(html);
      expect(metadata).toMatchObject({
        "twitter:title": "Twitter Title",
        ogImage: "https://example.com/image.jpg",
        "og:image": "https://example.com/image.jpg",
        ogDescription: "OpenGraph Description",
        "twitter:card": "summary",
        title: "Test Page Title",
        ogTitle: "OpenGraph Title",
        author: "Test Author",
        keywords: "test,page,keywords",
        "og:title": "OpenGraph Title",
        "og:description": "OpenGraph Description",
        description: "Detailed page description",
      });
    });

    it("should handle metadata with special characters and encoding", async () => {
      const html = `
        <html>
          <head>
            <title>Test &amp; Page with ©️ symbols</title>
            <meta name="description" content="Description with &quot;quotes&quot; and émojis 🎉">
            <meta property="og:title" content="Title with < and > symbols">
          </head>
          <body></body>
        </html>
      `;
      const metadata = await extractMetadata(html);
      expect(metadata.title).toContain("&");
      expect(metadata.description).toContain("quotes");
    });

    it("should handle missing or malformed metadata gracefully", async () => {
      const html = `
        <html>
          <head>
            <meta name="description" content="">
            <meta property="og:title">
            <meta name="keywords" content="  ">
          </head>
          <body></body>
        </html>
      `;
      const metadata = await extractMetadata(html);
      expect(metadata).toBeDefined();
    });

    it("should backfill title from og:title when title tag is missing", async () => {
      const html = `
        <html>
          <head>
            <meta property="og:title" content="OpenGraph Title">
            <meta name="description" content="Page description">
          </head>
          <body></body>
        </html>
      `;
      const metadata = await extractMetadata(html);
      expect(metadata.title).toBe("OpenGraph Title");
      expect(metadata.ogTitle).toBe("OpenGraph Title");
    });

    it("should backfill title from twitter:title when title and og:title are missing", async () => {
      const html = `
        <html>
          <head>
            <meta name="twitter:title" content="Twitter Title">
            <meta name="description" content="Page description">
          </head>
          <body></body>
        </html>
      `;
      const metadata = await extractMetadata(html);
      expect(metadata.title).toBe("Twitter Title");
    });

    it("should not backfill title when title tag exists", async () => {
      const html = `
        <html>
          <head>
            <title>Primary Title</title>
            <meta property="og:title" content="OpenGraph Title">
            <meta name="twitter:title" content="Twitter Title">
          </head>
          <body></body>
        </html>
      `;
      const metadata = await extractMetadata(html);
      expect(metadata.title).toBe("Primary Title");
      expect(metadata.ogTitle).toBe("OpenGraph Title");
    });
  });

  describe("transformHtml", () => {
    it("should transform HTML content according to options", async () => {
      const options: TransformHtmlOptions = {
        html: "<div><p>Test</p><span>Remove me</span></div>",
        url: "https://example.com",
        includeTags: ["p"],
        excludeTags: ["span"],
        onlyMainContent: true,
      };

      const result = await transformHtml(options);
      expect(result).toContain("<p>");
      expect(result).not.toContain("<span>");
    });

    it("should handle complex content filtering", async () => {
      const options: TransformHtmlOptions = {
        html: `
          <div class="wrapper">
            <header>
              <nav>Navigation</nav>
            </header>
            <main>
              <article>
                <h1>Title</h1>
                <p>Important content</p>
                <div class="ads">Advertisement</div>
                <aside>Sidebar</aside>
                <div class="social-share">Share buttons</div>
              </article>
            </main>
            <footer>Footer content</footer>
          </div>
        `,
        url: "https://example.com",
        includeTags: ["article", "h1", "p"],
        excludeTags: ["nav", "aside", "footer", ".ads", ".social-share"],
        onlyMainContent: true,
      };

      const result = await transformHtml(options);
      expect(result).toContain("<h1>Title</h1>");
      expect(result).toContain("<p>Important content</p>");
      expect(result).not.toContain("Navigation");
      expect(result).not.toContain("Advertisement");
      expect(result).not.toContain("Share buttons");
      expect(result).not.toContain("Footer content");
    });

    it("should handle nested content preservation and absolute links", async () => {
      const options: TransformHtmlOptions = {
        html: `
          <article>
            <div class="content">
              <h2>Section</h2>
              <p>Text with <strong>bold</strong> and <em>emphasis</em></p>
              <ul>
                <li>Item 1</li>
                <li>Item 2 <a href="#">with link</a></li>
              </ul>
            </div>
          </article>
        `,
        url: "https://example.com",
        includeTags: ["article", "p", "ul", "li"],
        excludeTags: [],
        onlyMainContent: true,
      };

      const result = await transformHtml(options);
      expect(result).toContain("<strong>bold</strong>");
      expect(result).toContain("<em>emphasis</em>");
      expect(result).toContain('<a href="https://example.com/#">');
    });

    it("should handle empty HTML content", async () => {
      const options: TransformHtmlOptions = {
        html: "",
        url: "https://example.com",
        includeTags: [],
        excludeTags: [],
        onlyMainContent: false,
      };

      const result = await transformHtml(options);
      expect(result).toBe("<html><body></body></html>");
    });

    it("should handle malformed HTML", async () => {
      const options: TransformHtmlOptions = {
        html: "<div>Unclosed div",
        url: "https://example.com",
        includeTags: [],
        excludeTags: [],
        onlyMainContent: false,
      };

      const result = await transformHtml(options);
      expect(result).toBe("<html><body><div>Unclosed div</div></body></html>");
    });

    it("should handle HTML with comments and scripts", async () => {
      const options: TransformHtmlOptions = {
        html: `
          <div>
            <!-- Comment -->
            <script>alert('test');</script>
            <p>Real content</p>
            <style>.test { color: red; }</style>
            <noscript>Enable JavaScript</noscript>
          </div>
        `,
        url: "https://example.com",
        includeTags: ["p"],
        excludeTags: ["script", "style", "noscript"],
        onlyMainContent: true,
      };

      const result = await transformHtml(options);
      expect(result).toContain("<p>Real content</p>");
      expect(result).not.toContain("alert");
      expect(result).not.toContain("color: red");
      expect(result).not.toContain("Enable JavaScript");
    });

    it("should handle special characters and encoding", async () => {
      const options: TransformHtmlOptions = {
        html: `
          <div>
            <p>&copy; 2024</p>
            <p>&lt;tag&gt;</p>
            <p>Special chars: á é í ó ú ñ</p>
            <p>Emojis: 🎉 👍 🚀</p>
          </div>
        `,
        url: "https://example.com",
        includeTags: ["p"],
        excludeTags: [],
        onlyMainContent: true,
      };

      const result = await transformHtml(options);
      expect(result).toContain("©");
      expect(result).toContain("á é í ó ú ñ");
      expect(result).toContain("🎉 👍 🚀");
    });

    it("should make all URLs absolute", async () => {
      const options: TransformHtmlOptions = {
        html: `
          <div>
            <a href="https://example.com/fullurl">hi</a>
            <a href="http://example.net/fullurl">hi</a>
            <a href="/pathurl">hi</a>
            <a href="//example.net/proturl">hi</a>
            <a href="?queryurl">hi</a>
            <a href="#hashurl">hi</a>
            <img src="#q1">
            <img src="#q2">
          </div>
        `,
        url: "https://example.com",
        includeTags: [],
        excludeTags: [],
        onlyMainContent: true,
      };

      const result = await transformHtml(options);
      console.log(result);
      expect(result).toContain("https://example.com/fullurl");
      expect(result).toContain("http://example.net/fullurl");
      expect(result).toContain("https://example.com/pathurl");
      expect(result).toContain("https://example.net/proturl");
      expect(result).toContain("https://example.com/?queryurl");
      expect(result).toContain("https://example.com/#hashurl");
      expect(result).toContain("https://example.com/#q1");
      expect(result).toContain("https://example.com/#q2");
    });
  });
});
