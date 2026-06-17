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
});
