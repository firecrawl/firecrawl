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

describe("extractProducts — OpenGraph", () => {
  it("extracts when a product price meta is present", async () => {
    const html = `<html><head>
      <meta property="og:type" content="product">
      <meta property="og:title" content="OG Shoe">
      <meta property="product:price:amount" content="120.00">
      <meta property="product:price:currency" content="EUR">
    </head><body></body></html>`;
    const p = await extractProducts(html, "https://x.test/s");
    expect(p!.title).toBe("OG Shoe");
    expect(p!.price).toEqual({
      amount: 120,
      currency: "EUR",
      formatted: expect.any(String),
    });
  });
  it("returns null for og:type=product WITHOUT a price (category/landing page)", async () => {
    const html = `<html><head>
      <meta property="og:type" content="product">
      <meta property="og:title" content="Buy Mac">
    </head><body></body></html>`;
    expect(
      await extractProducts(html, "https://apple.test/buy-mac"),
    ).toBeNull();
  });
});

describe("extractProducts — __NEXT_DATA__", () => {
  it("finds the page product via a known path", async () => {
    const blob = JSON.stringify({
      props: {
        pageProps: {
          product: {
            name: "Next Lamp",
            offers: { price: "30", priceCurrency: "USD" },
          },
        },
      },
    });
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${blob}</script></body></html>`;
    const p = await extractProducts(html, "https://x.test/lamp");
    expect(p!.title).toBe("Next Lamp");
    expect(p!.price?.amount).toBe(30);
  });
  it("prefers the page product over recommendations and bails on ambiguity", async () => {
    const blob = JSON.stringify({
      props: {
        pageProps: {
          recommendations: [
            { name: "Rec A", offers: { price: "1" } },
            { name: "Rec B", offers: { price: "2" } },
          ],
        },
      },
    });
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${blob}</script></body></html>`;
    expect(await extractProducts(html, "https://x.test/lamp")).toBeNull();
  });
});

describe("extractProducts — bonus sources", () => {
  it("recovers a product from GA4 dataLayer view_item (single item)", async () => {
    // NOTE: the brace scanner parses STRICT JSON (mirrors the Rust
    // `json_object_after`, which fails closed on JS object literals with
    // unquoted keys), so the GA4 event-params object after the `view_item`
    // anchor must be valid JSON — exactly how gtag emits it on the wire.
    const html = `<html><body><script>
      window.dataLayer = window.dataLayer || [];
      gtag("event", "view_item", { "currency": "USD", "items": [
        { "item_name": "DL Mug", "price": 12.5, "currency": "USD" } ] });
    </script></body></html>`;
    const p = await extractProducts(html, "https://x.test/mug");
    expect(p!.title).toBe("DL Mug");
    expect(p!.price?.amount).toBe(12.5);
  });
  it("reads RDFa Product (single typeof scope)", async () => {
    const html = `<html><body><div typeof="schema:Product">
      <span property="schema:name">RDFa Pen</span>
      <span property="schema:price" content="3.00"></span>
    </div></body></html>`;
    expect((await extractProducts(html, "https://x.test/pen"))!.title).toBe(
      "RDFa Pen",
    );
  });
  it("bails on multiple RDFa Product scopes (fail closed)", async () => {
    const scope = `<div typeof="schema:Product"><span property="schema:name">P</span><span property="schema:price" content="1"></span></div>`;
    const html = `<html><body>${scope}${scope}</body></html>`;
    expect(await extractProducts(html, "https://x.test/p")).toBeNull();
  });
  it("bails on multiple dataLayer items (item-list event, fail closed)", async () => {
    const html = `<html><body><script>
      dataLayer.push({ "ecommerce": { "items": [
        { "item_name": "A", "price": 1, "currency": "USD" },
        { "item_name": "B", "price": 2, "currency": "USD" } ] } });
    </script></body></html>`;
    expect(await extractProducts(html, "https://x.test/list")).toBeNull();
  });
  it("recovers a product from AliExpress window.runParams", async () => {
    const blob = JSON.stringify({
      data: {
        titleModule: { subject: "AE Cable" },
        priceModule: { minActivityAmount: { value: 4.2, currency: "USD" } },
        quantityModule: { totalAvailQuantity: 7 },
        pageModule: { description: "A cable", imagePath: "/img/cable.jpg" },
      },
    });
    const html = `<html><body><script>window.runParams = ${blob};</script></body></html>`;
    const p = await extractProducts(html, "https://x.test/cable");
    expect(p!.title).toBe("AE Cable");
    expect(p!.price?.amount).toBe(4.2);
    expect(p!.price?.currency).toBe("USD");
    expect(p!.availability?.inStock).toBe(true);
  });
});

describe("extractProducts — merge", () => {
  it("fills missing fields from a lower-priority source (JSON-LD title + OG price)", async () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Product","name":"Merge Item"}</script>
      <meta property="product:price:amount" content="42.00">
      <meta property="product:price:currency" content="USD">
    </head><body></body></html>`;
    const p = await extractProducts(html, "https://x.test/m");
    expect(p!.title).toBe("Merge Item"); // from JSON-LD (higher priority)
    expect(p!.price?.amount).toBe(42); // from OpenGraph (gap fill)
  });
  it("does not splice fields from a conflicting (different) product", async () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Product","name":"Real Product","sku":"AAA"}</script>
    </head><body>
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Totally Different</span>
        <span itemprop="sku">BBB</span>
        <span itemprop="price" content="999"></span>
      </div>
    </body></html>`;
    const p = await extractProducts(html, "https://x.test/m");
    expect(p!.title).toBe("Real Product");
    expect(p!.price).toBeUndefined(); // conflicting microdata dropped, not spliced
  });
});
