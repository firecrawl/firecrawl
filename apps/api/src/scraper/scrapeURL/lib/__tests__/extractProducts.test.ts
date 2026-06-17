import { extractProducts, STRUCTURED_FIELDS } from "../extractProducts";

describe("extractProducts — STRUCTURED_FIELDS", () => {
  it("exposes the canonical merge field order", () => {
    expect(STRUCTURED_FIELDS).toEqual([
      "id",
      "sku",
      "title",
      "brand",
      "description",
      "url",
      "price",
      "originalPrice",
      "availability",
      "images",
      "category",
      "variants",
    ]);
  });
});

describe("extractProducts — JSON-LD", () => {
  it("extracts a Product from JSON-LD", async () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Acme Boot",
       "brand":{"@type":"Brand","name":"Acme"},
       "offers":{"@type":"Offer","price":"49.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
    </script></head><body></body></html>`;
    const product = await extractProducts(html, "https://shop.example/boot");
    expect(product).not.toBeNull();
    expect(product!.title).toBe("Acme Boot");
    expect(product!.brand).toBe("Acme");
    expect(product!.price).toEqual({
      amount: 49.99,
      currency: "USD",
      formatted: expect.any(String),
    });
    expect(product!.availability?.inStock).toBe(true);
    expect(product!.url).toBe("https://shop.example/boot");
  });

  it("returns null for a non-product page (no Product node, no title)", async () => {
    const html = `<html><head><title>About us</title></head><body><p>hello</p></body></html>`;
    expect(
      await extractProducts(html, "https://shop.example/about"),
    ).toBeNull();
  });

  it("resolves a relative JSON-LD url against baseUrl", async () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","name":"Rel","url":"/products/rel",
       "offers":{"@type":"Offer","price":"5","priceCurrency":"USD"}}
    </script></head></html>`;
    const p = await extractProducts(html, "https://shop.example/listing");
    expect(p!.url).toBe("https://shop.example/products/rel");
  });
});

describe("extractProducts — microdata", () => {
  const productHtml = `<div itemscope itemtype="https://schema.org/Product">
    <span itemprop="name">Widget</span>
    <span itemprop="brand">Acme</span>
    <span itemprop="price" content="9.50"></span>
    <link itemprop="availability" href="https://schema.org/InStock">
  </div>`;
  it("reads itemprops from a single Product scope", async () => {
    const p = await extractProducts(
      `<html><body>${productHtml}</body></html>`,
      "https://x.test/w",
    );
    expect(p!.title).toBe("Widget");
    expect(p!.price?.amount).toBe(9.5);
  });
  it("bails on multiple Product scopes", async () => {
    const p = await extractProducts(
      `<html><body>${productHtml}${productHtml}</body></html>`,
      "https://x.test/w",
    );
    expect(p).toBeNull(); // ambiguous → no microdata product (and no other source here)
  });
  it("ignores itemprops outside the Product scope", async () => {
    const html = `<html><body><span itemprop="name">Outside</span>${productHtml}</body></html>`;
    const p = await extractProducts(html, "https://x.test/w");
    expect(p!.title).toBe("Widget");
  });
});
