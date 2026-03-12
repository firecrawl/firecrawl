import { hasNoExtractableText } from "./emptyPage";

describe("hasNoExtractableText", () => {
  it("treats blank HTML pages as having no extractable text", () => {
    expect(
      hasNoExtractableText(`
        <html>
          <head>
            <title>Blank page</title>
            <script>window.__APP__ = true;</script>
          </head>
          <body>
            <!-- intentionally empty -->
            <div id="root"></div>
          </body>
        </html>
      `),
    ).toBe(true);
  });

  it("detects visible page content", () => {
    expect(
      hasNoExtractableText(`
        <html>
          <body>
            <main>
              <h1>Hello</h1>
              <p>There is visible content here.</p>
            </main>
          </body>
        </html>
      `),
    ).toBe(false);
  });
});
