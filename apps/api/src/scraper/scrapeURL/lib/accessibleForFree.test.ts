import { isPaywalledByJsonLd } from "./accessibleForFree";

const page = (...blocks: string[]) =>
  `<html><head>${blocks
    .map(b => `<script type="application/ld+json">${b}</script>`)
    .join("")}</head><body><p>Full article body</p></body></html>`;

describe("isPaywalledByJsonLd", () => {
  it('blocks the string "False" in any case', () => {
    for (const value of ["False", "false", "FALSE", " false "]) {
      expect(
        isPaywalledByJsonLd(
          page(
            JSON.stringify({
              "@type": "NewsArticle",
              isAccessibleForFree: value,
            }),
          ),
        ),
      ).toBe(true);
    }
  });

  it("blocks the boolean false", () => {
    expect(
      isPaywalledByJsonLd(
        page('{"@type":"Article","isAccessibleForFree":false}'),
      ),
    ).toBe(true);
  });

  it('passes true and "True"', () => {
    expect(isPaywalledByJsonLd(page('{"isAccessibleForFree":true}'))).toBe(
      false,
    );
    expect(isPaywalledByJsonLd(page('{"isAccessibleForFree":"True"}'))).toBe(
      false,
    );
  });

  it("finds the marker inside @graph", () => {
    expect(
      isPaywalledByJsonLd(
        page(
          '{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Article","isAccessibleForFree":"False"}]}',
        ),
      ),
    ).toBe(true);
  });

  it("finds the marker in nested objects", () => {
    expect(
      isPaywalledByJsonLd(
        page(
          '{"@type":"Article","hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".body"}}',
        ),
      ),
    ).toBe(true);
  });

  it("checks every JSON-LD block", () => {
    expect(
      isPaywalledByJsonLd(
        page('{"@type":"WebSite"}', '{"isAccessibleForFree":"False"}'),
      ),
    ).toBe(true);
  });

  it("passes pages with no marker or no JSON-LD", () => {
    expect(isPaywalledByJsonLd(page('{"@type":"Article"}'))).toBe(false);
    expect(isPaywalledByJsonLd("<html><body>hello</body></html>")).toBe(false);
    expect(isPaywalledByJsonLd(undefined)).toBe(false);
    expect(isPaywalledByJsonLd("")).toBe(false);
  });

  it("ignores the marker outside JSON-LD scripts", () => {
    expect(
      isPaywalledByJsonLd(
        '<html><body><script>var a = {"isAccessibleForFree": false}</script></body></html>',
      ),
    ).toBe(false);
  });

  it("tolerates malformed JSON and still checks other blocks", () => {
    expect(
      isPaywalledByJsonLd(page('{"isAccessibleForFree": false', "not json")),
    ).toBe(false);
    expect(
      isPaywalledByJsonLd(
        page('{"isAccessibleForFree": false', '{"isAccessibleForFree":false}'),
      ),
    ).toBe(true);
  });
});
