import { parseMarkdown } from "../../../../lib/html-to-markdown";
import { scrapeOptions } from "../../../../controllers/v2/types";
import { htmlTransform } from "../removeUnwantedElements";

describe("htmlTransform + parseMarkdown", () => {
  it("produces markdown links for onclick window.open headlines", async () => {
    const rawHtml = `
      <html>
        <body>
          <h3 onclick="window.open('news-release.html?newsid=123&amp;symbol=NSP', '_blank').focus()">News</h3>
        </body>
      </html>
    `;

    const transformed = await htmlTransform(
      rawHtml,
      "https://example.com/press/",
      scrapeOptions.parse({}),
    );
    const markdown = await parseMarkdown(transformed);

    expect(markdown).toContain(
      "[News](https://example.com/press/news-release.html?newsid=123&symbol=NSP)",
    );
  });
});
