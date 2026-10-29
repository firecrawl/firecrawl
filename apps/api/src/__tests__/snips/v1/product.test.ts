import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "product-v1",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// The `product` scrape format is registered for both v1 and v2. The v2 suite
// covers the positive extraction paths; here we only need to prove the
// additive-only contract on v1: a scrape that does NOT request the `product`
// format is byte-identical in shape to a pre-feature v1 scrape (no `product`,
// no spurious `warning`, markdown + metadata intact). The product transformer
// is shared across v1/v2, so this guards the v1 format gate specifically.
describeIf(ALLOW_TEST_SUITE_WEBSITE)(
  "Product scrape format (v1 back-compat)",
  () => {
    const base = TEST_SUITE_WEBSITE;
    const productUrl = `${base}/product`;

    it.concurrent(
      "does not populate product when the product format is not requested (v1)",
      async () => {
        const response = await scrape(
          {
            url: productUrl,
            formats: ["markdown"],
          },
          identity,
        );

        expect(response.product).toBeUndefined();
        expect(response.warning).toBeUndefined();
        expect(response.markdown).toBeDefined();
        expect(typeof response.markdown).toBe("string");
        expect(response.markdown?.length).toBeGreaterThan(0);
        expect(response.metadata).toBeDefined();
        expect(response.metadata.statusCode).toBe(200);
      },
      scrapeTimeout,
    );
  },
);
