// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { findDeclaredJsonLdLogo } from "../../../scraper/scrapeURL/engines/fire-engine/branding-script/jsonld-logo";

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

  it("ignores malformed JSON and non-http schemes", () => {
    document.head.innerHTML =
      '<script type="application/ld+json">{broken</script>' +
      `<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", logo: "javascript:alert(1)" })}</script>`;
    expect(findDeclaredJsonLdLogo(document)).toBeNull();
  });
});
