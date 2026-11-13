import { extractLinksFromMarkdown } from "./extractLinksFromMarkdown";

const base = "https://example.com/llms.txt";

describe("extractLinksFromMarkdown", () => {
  it("extracts inline, reference, autolink and bare links", () => {
    const links = extractLinksFromMarkdown(
      [
        "- [Guide](/docs/guide)",
        "[ref]: https://example.com/ref",
        "<https://example.com/auto>",
        "See https://example.com/bare.",
      ].join("\n"),
      base,
    );

    expect(links).toEqual([
      "https://example.com/docs/guide",
      "https://example.com/ref",
      "https://example.com/auto",
      "https://example.com/bare",
    ]);
  });

  it("keeps balanced parentheses inside an inline link destination", () => {
    const links = extractLinksFromMarkdown(
      "- [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))",
      base,
    );

    expect(links).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
  });

  it("keeps balanced parentheses inside an inline link with a title", () => {
    const links = extractLinksFromMarkdown(
      '[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet) "Planet")',
      base,
    );

    expect(links).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
  });

  it("keeps balanced parentheses inside a bare URL", () => {
    const links = extractLinksFromMarkdown(
      "Read https://en.wikipedia.org/wiki/Venus_(planet) next.",
      base,
    );

    expect(links).toEqual(["https://en.wikipedia.org/wiki/Venus_(planet)"]);
  });

  it("does not take the closing parenthesis around a bare URL", () => {
    const links = extractLinksFromMarkdown(
      "(see https://example.com/page)",
      base,
    );

    expect(links).toEqual(["https://example.com/page"]);
  });

  it("keeps nested balanced parentheses in inline and bare URLs", () => {
    const links = extractLinksFromMarkdown(
      [
        "[link](https://example.com/foo(and(bar)))",
        "see https://example.com/x(y(z)w) here",
      ].join("\n"),
      base,
    );

    expect(links).toEqual([
      "https://example.com/foo(and(bar))",
      "https://example.com/x(y(z)w)",
    ]);
  });
});
