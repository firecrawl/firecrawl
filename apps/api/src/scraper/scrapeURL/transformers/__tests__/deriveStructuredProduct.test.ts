import { deriveStructuredProductFromHTML } from "../index";

const PRODUCT_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Acme Widget</title>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Acme Super Widget",
        "description": "The finest widget money can buy.",
        "sku": "WIDGET-123",
        "brand": { "@type": "Brand", "name": "Acme" },
        "offers": {
          "@type": "Offer",
          "price": "49.99",
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock"
        }
      }
    </script>
  </head>
  <body><h1>Acme Super Widget</h1></body>
</html>`;

const NON_PRODUCT_HTML = `<!DOCTYPE html>
<html>
  <head><title>About Us</title></head>
  <body>
    <h1>About Our Company</h1>
    <p>We are a company that does company things.</p>
  </body>
</html>`;

function makeMeta(formats: { type: string }[]): any {
  return {
    url: "https://example.com/products/widget",
    rewrittenUrl: undefined,
    options: { formats },
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
}

function makeDocument(html: string): any {
  return {
    html,
    rawHtml: html,
    metadata: {
      url: "https://example.com/products/widget",
      sourceURL: "https://example.com/products/widget",
      statusCode: 200,
    },
  };
}

describe("deriveStructuredProductFromHTML", () => {
  it("sets document.product for a JSON-LD product page", async () => {
    const meta = makeMeta([{ type: "product" }]);
    const document = makeDocument(PRODUCT_HTML);

    const result = await deriveStructuredProductFromHTML(meta, document);

    expect(result.product).toBeDefined();
    expect(result.product?.title).toBe("Acme Super Widget");
    expect(result.warning).toBeUndefined();
  });

  it("leaves product undefined and sets a no-product warning for a non-product page", async () => {
    const meta = makeMeta([{ type: "product" }]);
    const document = makeDocument(NON_PRODUCT_HTML);

    const result = await deriveStructuredProductFromHTML(meta, document);

    expect(result.product).toBeUndefined();
    expect(result.warning).toContain("No product found");
  });

  it("appends the no-product warning to a pre-existing warning rather than overwriting it", async () => {
    const meta = makeMeta([{ type: "product" }]);
    const document = makeDocument(NON_PRODUCT_HTML);
    document.warning = "Pre-existing warning.";

    const result = await deriveStructuredProductFromHTML(meta, document);

    expect(result.warning).toContain("No product found");
    expect(result.warning).toContain("Pre-existing warning.");
  });

  it("extracts from rawHtml even when cleaned html has stripped script/meta/head (pipeline simulation)", async () => {
    // Simulate the real pipeline: deriveHTMLFromRawHTML + removeUnwantedElements
    // strip <script>/<style>/<noscript>/<meta>/<head> from document.html BEFORE
    // this transformer runs, so the JSON-LD only survives in document.rawHtml.
    const STRIPPED_HTML = `<!DOCTYPE html>
<html>
  <body><h1>Acme Super Widget</h1></body>
</html>`;

    const meta = makeMeta([{ type: "product" }]);
    const document = makeDocument(STRIPPED_HTML);
    // rawHtml retains the original markup (with JSON-LD in <head><script>).
    document.rawHtml = PRODUCT_HTML;

    const result = await deriveStructuredProductFromHTML(meta, document);

    expect(result.product).toBeDefined();
    expect(result.product?.title).toBe("Acme Super Widget");
    expect(result.warning).toBeUndefined();
  });

  it("early-returns without touching product/warning when the product format is not requested", async () => {
    const meta = makeMeta([{ type: "markdown" }]);
    const document = makeDocument(PRODUCT_HTML);

    const result = await deriveStructuredProductFromHTML(meta, document);

    expect(result.product).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });
});
