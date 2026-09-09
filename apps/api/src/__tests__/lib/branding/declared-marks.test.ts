// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  findDeclaredJsonLdLogo,
  findLargestAppleTouchIcon,
} from "../../../scraper/scrapeURL/engines/fire-engine/branding-script/declared-marks";

function docWith(...blocks: unknown[]): Document {
  document.head.innerHTML = blocks
    .map(
      b => `<script type="application/ld+json">${JSON.stringify(b)}</script>`,
    )
    .join("");
  return document;
}

describe("findDeclaredJsonLdLogo", () => {
  it("accepts an Organization logo", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({ "@type": "Organization", logo: "https://x.com/logo.png" }),
      ),
    ).toBe("https://x.com/logo.png");
  });

  it("resolves relative and protocol-relative URLs against the page", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({ "@type": "WebSite", logo: "/logo.svg" }),
      ),
    ).toMatch(/^https?:\/\/.+\/logo\.svg$/);
  });

  it("accepts ImageObject-shaped logos", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "LocalBusiness",
          logo: { "@type": "ImageObject", url: "https://x.com/lb.png" },
        }),
      ),
    ).toBe("https://x.com/lb.png");
  });

  it("skips product/brand logos (manufacturer, not the site)", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Product",
          name: "Shoe",
          brand: { "@type": "Brand", logo: "https://nike.com/swoosh.png" },
        }),
      ),
    ).toBeNull();
  });

  it("skips Product-family subtypes (schema.org allows logo on Product)", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "IndividualProduct",
          logo: "https://maker.com/product-logo.png",
        }),
      ),
    ).toBeNull();
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "ProductModel",
          logo: "https://maker.com/model-logo.png",
        }),
      ),
    ).toBeNull();
  });

  it("finds the site org even when a product block comes first", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith(
          {
            "@type": "Product",
            brand: { "@type": "Brand", logo: "https://nike.com/swoosh.png" },
          },
          { "@type": "Organization", logo: "https://shop.com/logo.png" },
        ),
      ),
    ).toBe("https://shop.com/logo.png");
  });

  it("handles @graph arrays and array @type", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@graph": [
            {
              "@type": ["Restaurant", "LocalBusiness"],
              logo: "https://r.com/l.png",
            },
          ],
        }),
      ),
    ).toBe("https://r.com/l.png");
  });

  it("prefers contentUrl over url when ImageObject declares both", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: {
            "@type": "ImageObject",
            url: "https://x.com/about-the-logo.html",
            contentUrl: "https://x.com/logo-file.png",
          },
        }),
      ),
    ).toBe("https://x.com/logo-file.png");
  });

  it("falls back to url when contentUrl is present but unusable", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: { contentUrl: "", url: "https://x.com/logo.png" },
        }),
      ),
    ).toBe("https://x.com/logo.png");
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: { contentUrl: "ipfs://Qm123", url: "https://x.com/logo.png" },
        }),
      ),
    ).toBe("https://x.com/logo.png");
  });

  it("accepts ImageObject contentUrl (canonical media URL property)", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: { "@type": "ImageObject", contentUrl: "https://x.com/c.png" },
        }),
      ),
    ).toBe("https://x.com/c.png");
  });

  it("does not leak logos of untyped children under denied entities", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Product",
          brand: { name: "Nike", logo: "https://nike.com/swoosh.png" },
        }),
      ),
    ).toBeNull();
  });

  describe("findLargestAppleTouchIcon", () => {
    function docWithLinks(...links: string[]): Document {
      document.head.innerHTML = links.join("");
      return document;
    }

    it("uses the max dimension across multi-token sizes attributes", () => {
      expect(
        findLargestAppleTouchIcon(
          docWithLinks(
            '<link rel="apple-touch-icon" sizes="57x57 180x180" href="/multi.png">',
            '<link rel="apple-touch-icon" sizes="152x152" href="/single.png">',
          ),
        ),
      ).toMatch(/multi\.png$/);
    });

    it("rejects non-image schemes", () => {
      expect(
        findLargestAppleTouchIcon(
          docWithLinks(
            '<link rel="apple-touch-icon" href="javascript:alert(1)">',
          ),
        ),
      ).toBeNull();
    });
  });

  it("does not treat @context term definitions as logos", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith(
          {
            "@context": { logo: "https://schema.org/logo" },
            "@type": "Article",
            headline: "Post",
          },
          { "@type": "Organization", logo: "https://x.com/real-logo.png" },
        ),
      ),
    ).toBe("https://x.com/real-logo.png");
  });

  it("handles array-valued logos (first resolvable wins)", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: ["", "https://x.com/a.png", "https://x.com/b.png"],
        }),
      ),
    ).toBe("https://x.com/a.png");
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: [{ "@type": "ImageObject", contentUrl: "https://x.com/c.png" }],
        }),
      ),
    ).toBe("https://x.com/c.png");
  });

  it("dereferences @id node references (Yoast @graph pattern)", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Organization",
              "@id": "https://site.com/#organization",
              logo: { "@id": "https://site.com/#/schema/logo/image/" },
            },
            {
              "@type": "ImageObject",
              "@id": "https://site.com/#/schema/logo/image/",
              url: "https://site.com/wp-content/logo.png",
              contentUrl: "https://site.com/wp-content/logo.png",
            },
          ],
        }),
      ),
    ).toBe("https://site.com/wp-content/logo.png");
  });

  it("dereferences @id across separate JSON-LD blocks", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith(
          {
            "@type": "Organization",
            logo: { "@id": "https://site.com/#logo-node" },
          },
          {
            "@type": "ImageObject",
            "@id": "https://site.com/#logo-node",
            contentUrl: "https://site.com/logo.svg",
          },
        ),
      ),
    ).toBe("https://site.com/logo.svg");
  });

  it("never uses a fragment @id as an image URL", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: { "@id": "https://site.com/#/schema/logo/image/" },
        }),
      ),
    ).toBeNull();
  });

  it("uses a fragment-free @id URL directly when unresolvable", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "Organization",
          logo: { "@id": "https://site.com/assets/logo.png" },
        }),
      ),
    ).toBe("https://site.com/assets/logo.png");
  });

  it("walks @included blocks", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@type": "WebPage",
          "@included": [
            { "@type": "Organization", logo: "https://x.com/inc-logo.png" },
          ],
        }),
      ),
    ).toBe("https://x.com/inc-logo.png");
  });

  it("does not dereference into denied entities", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@graph": [
            {
              "@type": "Organization",
              logo: { "@id": "https://site.com/#brandnode" },
            },
            {
              "@type": "Brand",
              "@id": "https://site.com/#brandnode",
              url: "https://nike.com/swoosh.png",
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("prefers the @id definition carrying an image URL (split definitions)", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@graph": [
            {
              "@type": "Organization",
              logo: { "@id": "https://site.com/#logo" },
            },
            { "@id": "https://site.com/#logo", caption: "Logo" },
            {
              "@type": "ImageObject",
              "@id": "https://site.com/#logo",
              contentUrl: "https://site.com/full-logo.png",
            },
          ],
        }),
      ),
    ).toBe("https://site.com/full-logo.png");
  });

  it("split definition with unusable URLs does not shadow a usable one", () => {
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@graph": [
            {
              "@type": "Organization",
              logo: { "@id": "https://site.com/#logo" },
            },
            {
              "@type": "ImageObject",
              "@id": "https://site.com/#logo",
              contentUrl: "ipfs://Qm123",
            },
            {
              "@type": "ImageObject",
              "@id": "https://site.com/#logo",
              contentUrl: "https://site.com/usable-logo.png",
            },
          ],
        }),
      ),
    ).toBe("https://site.com/usable-logo.png");
  });

  it("matches relative and absolute @id spellings", () => {
    const abs = new URL("/#logo-rel", document.location.href).href;
    expect(
      findDeclaredJsonLdLogo(
        docWith({
          "@graph": [
            { "@type": "Organization", logo: { "@id": "/#logo-rel" } },
            {
              "@type": "ImageObject",
              "@id": abs,
              contentUrl: "https://site.com/rel-logo.png",
            },
          ],
        }),
      ),
    ).toBe("https://site.com/rel-logo.png");
  });

  it("ignores malformed JSON and non-http schemes", () => {
    document.head.innerHTML =
      '<script type="application/ld+json">{broken</script>' +
      `<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", logo: "javascript:alert(1)" })}</script>`;
    expect(findDeclaredJsonLdLogo(document)).toBeNull();
  });
});
