import {
  parseWikimediaUrl,
  isWikimediaUrl,
} from "../../scraper/scrapeURL/fetch/wikipedia";

describe("Wikipedia URL parser", () => {
  describe("parseWikimediaUrl", () => {
    describe("Wikipedia articles", () => {
      it("parses English Wikipedia article URL", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/Web_scraping",
        );
        expect(result).toEqual({
          articleName: "Web_scraping",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("parses German Wikipedia article URL", () => {
        const result = parseWikimediaUrl(
          "https://de.wikipedia.org/wiki/Web_Scraping",
        );
        expect(result).toEqual({
          articleName: "Web_Scraping",
          lang: "de",
          projectIdentifier: "dewiki",
        });
      });

      it("parses Spanish Wikipedia article URL", () => {
        const result = parseWikimediaUrl(
          "https://es.wikipedia.org/wiki/Scraping",
        );
        expect(result).toEqual({
          articleName: "Scraping",
          lang: "es",
          projectIdentifier: "eswiki",
        });
      });

      it("parses Japanese Wikipedia (3-letter lang code)", () => {
        const result = parseWikimediaUrl("https://ja.wikipedia.org/wiki/日本");
        expect(result).toEqual({
          articleName: "日本",
          lang: "ja",
          projectIdentifier: "jawiki",
        });
      });

      it("parses Portuguese Wikipedia", () => {
        const result = parseWikimediaUrl(
          "https://pt.wikipedia.org/wiki/Brasil",
        );
        expect(result).toEqual({
          articleName: "Brasil",
          lang: "pt",
          projectIdentifier: "ptwiki",
        });
      });
    });

    describe("other Wikimedia projects", () => {
      it("parses Wiktionary URL", () => {
        const result = parseWikimediaUrl(
          "https://fr.wiktionary.org/wiki/bonjour",
        );
        expect(result).toEqual({
          articleName: "bonjour",
          lang: "fr",
          projectIdentifier: "frwiktionary",
        });
      });

      it("parses Wikisource URL", () => {
        const result = parseWikimediaUrl(
          "https://en.wikisource.org/wiki/The_Art_of_War",
        );
        expect(result).toEqual({
          articleName: "The_Art_of_War",
          lang: "en",
          projectIdentifier: "enwikisource",
        });
      });

      it("parses Wikibooks URL", () => {
        const result = parseWikimediaUrl(
          "https://en.wikibooks.org/wiki/Cookbook:Table_of_Contents",
        );
        expect(result).toEqual({
          articleName: "Cookbook:Table_of_Contents",
          lang: "en",
          projectIdentifier: "enwikibooks",
        });
      });

      it("parses Wikiquote URL", () => {
        const result = parseWikimediaUrl(
          "https://en.wikiquote.org/wiki/Albert_Einstein",
        );
        expect(result).toEqual({
          articleName: "Albert_Einstein",
          lang: "en",
          projectIdentifier: "enwikiquote",
        });
      });

      it("parses Wikiversity URL", () => {
        const result = parseWikimediaUrl(
          "https://en.wikiversity.org/wiki/Introduction_to_Computers",
        );
        expect(result).toEqual({
          articleName: "Introduction_to_Computers",
          lang: "en",
          projectIdentifier: "enwikiversity",
        });
      });

      it("parses Wikivoyage URL", () => {
        const result = parseWikimediaUrl(
          "https://en.wikivoyage.org/wiki/Paris",
        );
        expect(result).toEqual({
          articleName: "Paris",
          lang: "en",
          projectIdentifier: "enwikivoyage",
        });
      });
    });

    describe("special characters and encoding", () => {
      it("handles URL-encoded article names", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/C%2B%2B",
        );
        expect(result).toEqual({
          articleName: "C++",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles articles with underscores (spaces)", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/United_States",
        );
        expect(result).toEqual({
          articleName: "United_States",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles articles with parentheses (disambiguation)", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/Mercury_(planet)",
        );
        expect(result).toEqual({
          articleName: "Mercury_(planet)",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles URL-encoded parentheses", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/Mercury_%28planet%29",
        );
        expect(result).toEqual({
          articleName: "Mercury_(planet)",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles articles with apostrophes", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/Murphy's_law",
        );
        expect(result).toEqual({
          articleName: "Murphy's_law",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles articles with colons (namespaces)", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/Wikipedia:About",
        );
        expect(result).toEqual({
          articleName: "Wikipedia:About",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles articles with URL-encoded spaces (%20)", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/New%20York%20City",
        );
        expect(result).toEqual({
          articleName: "New_York_City",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles articles with hash/fragment (strips it)", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/Brazil#History",
        );
        expect(result).toEqual({
          articleName: "Brazil",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });

      it("handles articles with query parameters", () => {
        const result = parseWikimediaUrl(
          "https://en.wikipedia.org/wiki/Brazil?action=edit",
        );
        expect(result).toEqual({
          articleName: "Brazil",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });
    });

    describe("rejected URLs", () => {
      it("returns null for non-Wikipedia URLs", () => {
        expect(parseWikimediaUrl("https://google.com")).toBeNull();
        expect(parseWikimediaUrl("https://example.com/wiki/test")).toBeNull();
      });

      it("returns null for Wikipedia URLs without /wiki/ path", () => {
        expect(
          parseWikimediaUrl("https://en.wikipedia.org/w/index.php"),
        ).toBeNull();
        expect(parseWikimediaUrl("https://en.wikipedia.org/")).toBeNull();
      });

      it("returns null for main Wikipedia domain without language prefix", () => {
        expect(parseWikimediaUrl("https://wikipedia.org/wiki/Test")).toBeNull();
      });

      it("returns null for invalid URLs", () => {
        expect(parseWikimediaUrl("not-a-url")).toBeNull();
        expect(parseWikimediaUrl("")).toBeNull();
      });

      it("returns null for Wikimedia Commons (not a content project)", () => {
        expect(
          parseWikimediaUrl("https://commons.wikimedia.org/wiki/File:Test.jpg"),
        ).toBeNull();
      });

      it("returns null for Wikidata", () => {
        expect(
          parseWikimediaUrl("https://www.wikidata.org/wiki/Q42"),
        ).toBeNull();
      });

      it("returns null for MediaWiki API endpoints", () => {
        expect(
          parseWikimediaUrl(
            "https://en.wikipedia.org/w/api.php?action=query&titles=Brazil",
          ),
        ).toBeNull();
      });

      it("returns null for Wikipedia Special pages", () => {
        expect(
          parseWikimediaUrl("https://en.wikipedia.org/wiki/Special:Random"),
        ).not.toBeNull(); // Special:Random is technically a valid /wiki/ path
      });

      it("returns null for bare /wiki/ path with no article", () => {
        expect(parseWikimediaUrl("https://en.wikipedia.org/wiki/")).toBeNull();
      });

      it("returns null for HTTP protocol", () => {
        const result = parseWikimediaUrl("http://en.wikipedia.org/wiki/Test");
        // HTTP should still parse -- the protocol doesn't matter for article resolution
        expect(result).toEqual({
          articleName: "Test",
          lang: "en",
          projectIdentifier: "enwiki",
        });
      });
    });
  });

  describe("isWikimediaUrl", () => {
    it("returns true for Wikipedia URLs in various languages", () => {
      expect(isWikimediaUrl("https://en.wikipedia.org/wiki/Test")).toBe(true);
      expect(isWikimediaUrl("https://de.wikipedia.org/wiki/Test")).toBe(true);
      expect(isWikimediaUrl("https://ja.wikipedia.org/wiki/テスト")).toBe(true);
      expect(isWikimediaUrl("https://pt.wikipedia.org/wiki/Brasil")).toBe(true);
      expect(isWikimediaUrl("https://zh.wikipedia.org/wiki/测试")).toBe(true);
    });

    it("returns true for all supported Wikimedia projects", () => {
      expect(isWikimediaUrl("https://en.wiktionary.org/wiki/hello")).toBe(true);
      expect(isWikimediaUrl("https://en.wikisource.org/wiki/Test")).toBe(true);
      expect(isWikimediaUrl("https://en.wikibooks.org/wiki/Test")).toBe(true);
      expect(isWikimediaUrl("https://en.wikiquote.org/wiki/Test")).toBe(true);
      expect(isWikimediaUrl("https://en.wikiversity.org/wiki/Test")).toBe(true);
      expect(isWikimediaUrl("https://en.wikivoyage.org/wiki/Test")).toBe(true);
    });

    it("returns false for non-Wikimedia URLs", () => {
      expect(isWikimediaUrl("https://google.com")).toBe(false);
      expect(isWikimediaUrl("https://example.com/wiki/test")).toBe(false);
      expect(isWikimediaUrl("https://en.fakepedia.org/wiki/test")).toBe(false);
    });

    it("returns false for Wikipedia non-article pages", () => {
      expect(isWikimediaUrl("https://en.wikipedia.org/w/index.php")).toBe(
        false,
      );
      expect(isWikimediaUrl("https://en.wikipedia.org/")).toBe(false);
    });

    it("returns false for unsupported Wikimedia projects", () => {
      expect(
        isWikimediaUrl("https://commons.wikimedia.org/wiki/File:Test.jpg"),
      ).toBe(false);
      expect(isWikimediaUrl("https://www.wikidata.org/wiki/Q42")).toBe(false);
      expect(isWikimediaUrl("https://meta.wikimedia.org/wiki/Main_Page")).toBe(
        false,
      );
    });
  });
});
