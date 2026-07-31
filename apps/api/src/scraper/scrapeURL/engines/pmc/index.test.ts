import { convertBiocToHtml, extractPmcId, isPmcArticleUrl } from "./index";
import { EngineError } from "../../error";

const SOURCE_URL = "https://pmc.ncbi.nlm.nih.gov/articles/PMC5968224/";

/** Shaped like a real BioC response, trimmed to the passages that matter. */
function biocFixture(overrides: { passages?: unknown[] } = {}) {
  return [
    {
      source: "PMC",
      documents: [
        {
          id: "PMC5968224",
          infons: { license: "CC BY" },
          passages: overrides.passages ?? [
            {
              infons: {
                "article-id_doi": "10.3352/jeehp.2018.15.7",
                "article-id_pmc": "PMC5968224",
                "article-id_pmid": "29575849",
                kwd: "Algorithms Computers Computerized adaptive testing",
                name_0: "surname:Han;given-names:Kyung (Chris) Tyek",
                name_1: "surname:Huh;given-names:Sun",
                section_type: "TITLE",
                type: "front",
                volume: "15",
                year: "2018",
              },
              offset: 0,
              text: "Components of the item selection algorithm in computerized adaptive testing",
            },
            {
              infons: { section_type: "ABSTRACT", type: "abstract" },
              offset: 76,
              text: "Computerized adaptive testing greatly improves measurement efficiency in high-stakes testing operations through the selection and administration of test items with the difficulty matched to each examinee.",
            },
            {
              infons: { section_type: "INTRO", type: "title_1" },
              offset: 1891,
              text: "Introduction",
            },
            {
              infons: { section_type: "INTRO", type: "paragraph" },
              offset: 1904,
              text: "The emergence and advancement of modern test theory and the rapid deployment of new computing technologies have completely changed how educational measurement is carried out in practice today.",
            },
            {
              infons: { section_type: "INTRO", type: "title_2" },
              offset: 2600,
              text: "Item selection",
            },
            {
              infons: { section_type: "REF", type: "ref" },
              offset: 9000,
              text: "Han KT. Components of the item selection algorithm. J Educ Eval Health Prof. 2018.",
            },
          ],
        },
      ],
    },
  ];
}

describe("extractPmcId", () => {
  it("extracts the id from a canonical PMC article URL", () => {
    expect(extractPmcId(SOURCE_URL)).toBe("PMC5968224");
    expect(
      extractPmcId("https://pmc.ncbi.nlm.nih.gov/articles/PMC5968224"),
    ).toBe("PMC5968224");
  });

  it("extracts the id from the legacy www.ncbi.nlm.nih.gov/pmc path", () => {
    expect(
      extractPmcId("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/"),
    ).toBe("PMC1234567");
  });

  it("normalises a lowercase id", () => {
    expect(
      extractPmcId("https://pmc.ncbi.nlm.nih.gov/articles/pmc5968224/"),
    ).toBe("PMC5968224");
  });

  it("ignores query strings and fragments", () => {
    expect(extractPmcId(`${SOURCE_URL}?report=classic#abstract`)).toBe(
      "PMC5968224",
    );
  });

  it("returns null for malformed or unsupported ids", () => {
    for (const url of [
      "https://pmc.ncbi.nlm.nih.gov/articles/PMCABCDEF/",
      "https://pmc.ncbi.nlm.nih.gov/articles/12345/",
      "https://pmc.ncbi.nlm.nih.gov/articles/",
      "https://pmc.ncbi.nlm.nih.gov/",
    ]) {
      expect(extractPmcId(url)).toBeNull();
    }
  });

  it("returns null for other hosts and non-article paths", () => {
    for (const url of [
      "https://example.com/articles/PMC5968224/",
      "https://pmc.ncbi.nlm.nih.gov.evil.com/articles/PMC5968224/",
      "https://www.mdpi.com/2308-3417/10/5/119",
    ]) {
      expect(extractPmcId(url)).toBeNull();
    }
  });

  it("returns null for non-http(s) and unparseable URLs", () => {
    for (const url of ["file:///articles/PMC1/", "not a url", ""]) {
      expect(extractPmcId(url)).toBeNull();
    }
  });

  it("isPmcArticleUrl mirrors extractPmcId", () => {
    expect(isPmcArticleUrl(SOURCE_URL)).toBe(true);
    expect(isPmcArticleUrl("https://www.mdpi.com/2308-3417/10/5/119")).toBe(
      false,
    );
  });
});

describe("convertBiocToHtml", () => {
  it("converts a full-text article, preserving title, headings and metadata", () => {
    const { html, title } = convertBiocToHtml(
      biocFixture(),
      SOURCE_URL,
      "PMC5968224",
    );

    expect(title).toBe(
      "Components of the item selection algorithm in computerized adaptive testing",
    );
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`<h1>${title}</h1>`);

    // Section structure survives the conversion.
    expect(html).toContain("<h2>Abstract</h2>");
    expect(html).toContain("<h2>Introduction</h2>");
    expect(html).toContain("<h3>Item selection</h3>");
    expect(html).toContain("<h2>References</h2>");
    expect(html).toContain("Computerized adaptive testing greatly improves");

    // Useful bibliographic metadata is emitted where extractMetadata reads it.
    expect(html).toContain(
      'name="citation_doi" content="10.3352/jeehp.2018.15.7"',
    );
    expect(html).toContain('name="citation_pmid" content="29575849"');
    expect(html).toContain('name="citation_pmcid" content="PMC5968224"');
    expect(html).toContain('content="Kyung (Chris) Tyek Han"');
    expect(html).toContain('content="Sun Huh"');
    expect(html).toContain(`<link rel="canonical" href="${SOURCE_URL}">`);

    // And it must be the article, not a challenge page.
    expect(html.toLowerCase()).not.toContain("recaptcha");
  });

  it("escapes HTML in passage text", () => {
    const fixture = biocFixture({
      passages: [
        {
          infons: { type: "front", section_type: "TITLE" },
          text: "Tags <script>alert(1)</script> & entities",
        },
        {
          infons: { type: "paragraph", section_type: "INTRO" },
          text: `${'Body copy with <b>markup</b> and "quotes". '.repeat(10)}`,
        },
      ],
    });
    const { html } = convertBiocToHtml(fixture, SOURCE_URL, "PMC5968224");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  describe("rejects payloads that are not usable full text", () => {
    it("throws when the payload is not a collection array", () => {
      for (const payload of [null, undefined, {}, [], "text", 42]) {
        expect(() =>
          convertBiocToHtml(payload, SOURCE_URL, "PMC5968224"),
        ).toThrow(EngineError);
      }
    });

    it("throws when there are no documents or passages", () => {
      expect(() =>
        convertBiocToHtml([{ documents: [] }], SOURCE_URL, "PMC5968224"),
      ).toThrow(EngineError);
      expect(() =>
        convertBiocToHtml(
          [{ documents: [{ id: "PMC1", passages: [] }] }],
          SOURCE_URL,
          "PMC5968224",
        ),
      ).toThrow(EngineError);
    });

    it("throws on a metadata-only record with no body text", () => {
      // Non-open-access records come back as a title and nothing else. That is
      // an unavailable article, not a successful scrape.
      const fixture = biocFixture({
        passages: [
          {
            infons: { type: "front", section_type: "TITLE" },
            text: "A title but no licensed full text",
          },
        ],
      });
      expect(() =>
        convertBiocToHtml(fixture, SOURCE_URL, "PMC5968224"),
      ).toThrow(/no usable full text/);
    });

    it("throws when only references are present", () => {
      const fixture = biocFixture({
        passages: [
          {
            infons: { type: "front", section_type: "TITLE" },
            text: "Title only",
          },
          {
            infons: { type: "ref", section_type: "REF" },
            text: "Some citation",
          },
        ],
      });
      expect(() =>
        convertBiocToHtml(fixture, SOURCE_URL, "PMC5968224"),
      ).toThrow(/no usable full text/);
    });

    it("throws when the title is missing", () => {
      const fixture = biocFixture({
        passages: [
          {
            infons: { type: "paragraph", section_type: "INTRO" },
            text: "Body text without any title passage. ".repeat(20),
          },
        ],
      });
      expect(() =>
        convertBiocToHtml(fixture, SOURCE_URL, "PMC5968224"),
      ).toThrow(/no usable full text/);
    });
  });
});
