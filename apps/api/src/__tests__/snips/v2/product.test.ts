import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "product",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// The `product` scrape format extracts a structured product from a page's HTML
// (JSON-LD / microdata / etc.). These tests target the static test-site product
// fixture (`apps/test-site/src/pages/product.astro`), which embeds a schema.org
// JSON-LD Product, and a plain non-product page (`/about`). A local test-site
// fetch needs neither fire-engine nor AI, so we gate exactly like the other
// test-site fetch tests (scrape-formats.test.ts) on ALLOW_TEST_SUITE_WEBSITE.
describeIf(ALLOW_TEST_SUITE_WEBSITE)("Product scrape format", () => {
  const base = TEST_SUITE_WEBSITE;
  const productUrl = `${base}/product`;
  const nonProductUrl = `${base}/about`;

  it.concurrent(
    "extracts a structured product from a JSON-LD product page",
    async () => {
      const response = await scrape(
        {
          url: productUrl,
          formats: [{ type: "product" }],
        },
        identity,
      );

      expect(response.product).toBeDefined();
      expect(response.product?.title).toBe("Firecrawl Test Widget");
      expect(response.product?.price).toBeDefined();
      expect(response.product?.price?.amount).toBe(49.99);
      expect(response.product?.price?.currency).toBe("USD");
      expect(response.product?.availability).toBeDefined();
      expect(response.product?.availability?.inStock).toBe(true);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "sets a no-product warning for a non-product page",
    async () => {
      const response = await scrape(
        {
          url: nonProductUrl,
          formats: [{ type: "product" }],
        },
        identity,
      );

      expect(response.product).toBeUndefined();
      expect(response.warning).toBeDefined();
      expect(response.warning).toContain("No product found");
    },
    scrapeTimeout,
  );

  it.concurrent(
    "does not populate product when the product format is not requested",
    async () => {
      const response = await scrape(
        {
          url: productUrl,
          formats: ["markdown"],
        },
        identity,
      );

      // Additive-only contract: a scrape that does not request the `product`
      // format must be byte-identical in shape to a pre-feature scrape.
      // No `product` field...
      expect(response.product).toBeUndefined();
      // ...and no spurious `warning` (the no-product warning is only emitted
      // when the format is actually requested).
      expect(response.warning).toBeUndefined();
      // ...while the rest of the document is present and unchanged.
      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
      expect(response.markdown?.length).toBeGreaterThan(0);
      expect(response.metadata).toBeDefined();
      expect(response.metadata.sourceURL ?? response.metadata.url).toBe(
        productUrl,
      );
      expect(response.metadata.statusCode).toBe(200);
    },
    scrapeTimeout,
  );
});
