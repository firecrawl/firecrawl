import { idmux, Identity, parse, scrapeTimeout } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "parse-markdown-links",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

async function parseHtml(html: string): Promise<string> {
  const result = await parse(
    {
      options: { formats: ["markdown"] },
      file: {
        content: `<!DOCTYPE html><html><body>${html}</body></html>`,
        filename: "links.html",
        contentType: "text/html",
      },
    },
    identity,
  );
  return result.markdown ?? "";
}

// The Go converter writes a line break inside link text as `\` + newline (a
// CommonMark hard break), and Turndown collapses it to a space. Either is
// fine, but a second backslash would render as a literal `\` in the text.
describe("Markdown for link text that spans lines", () => {
  it(
    "keeps a newline inside link text as a single hard break",
    async () => {
      const markdown = await parseHtml(
        `<p>see the <a href="https://e.com/a">Secret\nNumber</a> section</p>`,
      );

      expect(markdown).toMatch(
        /\[Secret(\\\n| )Number\]\(https:\/\/e\.com\/a\)/,
      );
    },
    scrapeTimeout,
  );

  it(
    "keeps a <br> inside link text as hard breaks",
    async () => {
      const markdown = await parseHtml(
        `<p><a href="https://e.com/a">Line one<br>Line two</a></p>`,
      );

      expect(markdown).toMatch(
        /\[Line one *(\\\n)+Line two\]\(https:\/\/e\.com\/a\)/,
      );
    },
    scrapeTimeout,
  );

  it(
    "still escapes a newline that follows a literal backslash",
    async () => {
      // The Go converter leaves the literal `\` unescaped, so `C:\` plus its
      // hard break reads as an escaped backslash and a bare newline. The
      // newline still needs its own `\`.
      const markdown = await parseHtml(
        `<p><a href="https://e.com/a">C:\\\nUsers</a></p>`,
      );

      expect(markdown).toMatch(
        /\[C:\\\\(\\\n| )Users\]\(https:\/\/e\.com\/a\)/,
      );
    },
    scrapeTimeout,
  );
});
