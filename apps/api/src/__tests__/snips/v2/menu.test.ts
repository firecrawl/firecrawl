import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_MENU_SERVICE,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "menu",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// The `menu` scrape format extracts a structured restaurant menu from a page's
// HTML. The extraction itself runs in the menu-search Rust service, called over
// HTTP when MENU_EXTRACTION_SERVICE_URL is set (the product → PRODUCT_EXTRACTION_
// SERVICE_URL pattern). These tests target a representative real restaurant menu
// page for the positive path, and the static test-site non-menu pages
// (`/about`, `/product`) for the negative / absence paths. Because the format
// requires the external extractor, we gate on HAS_MENU_SERVICE so the suite only
// runs where the service is configured (mirroring how the product snips are
// gated on HAS_PRODUCT_SERVICE); and we also gate on ALLOW_TEST_SUITE_WEBSITE
// because the negative / absence cases fetch the local test-site.
describeIf(ALLOW_TEST_SUITE_WEBSITE && HAS_MENU_SERVICE)(
  "Menu scrape format",
  () => {
    const base = TEST_SUITE_WEBSITE;
    // A representative restaurant menu page (Toast online ordering) for the live
    // extraction path. The page embeds a structured menu the service can parse.
    const menuUrl =
      "https://order.toasttab.com/online/the-coffee-shop-123-main-st";
    const nonMenuUrl = `${base}/about`;
    const productUrl = `${base}/product`;

    it.concurrent(
      "extracts a structured menu from a restaurant menu page",
      async () => {
        const response = await scrape(
          {
            url: menuUrl,
            formats: [{ type: "menu" }],
          },
          identity,
        );

        expect(response.menu).toBeDefined();
        // Canonical shape: a merchant profile plus an ordered list of sections,
        // each holding items.
        expect(response.menu?.isMenu).toBe(true);
        expect(response.menu?.merchant).toBeDefined();
        expect(typeof response.menu?.merchant?.name).toBe("string");
        expect(Array.isArray(response.menu?.sections)).toBe(true);
        expect(response.menu?.sections?.length).toBeGreaterThan(0);
        const section = response.menu?.sections?.[0];
        expect(section).toBeDefined();
        expect(typeof section?.name).toBe("string");
        expect(Array.isArray(section?.items)).toBe(true);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "sets a no-menu warning for a non-menu page",
      async () => {
        const response = await scrape(
          {
            url: nonMenuUrl,
            formats: [{ type: "menu" }],
          },
          identity,
        );

        expect(response.menu).toBeUndefined();
        expect(response.warning).toBeDefined();
        expect(response.warning).toContain("No menu found");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "does not populate menu when the menu format is not requested",
      async () => {
        const response = await scrape(
          {
            url: productUrl,
            formats: ["markdown"],
          },
          identity,
        );

        // Additive-only contract: a scrape that does not request the `menu`
        // format must be byte-identical in shape to a pre-feature scrape.
        // No `menu` field...
        expect(response.menu).toBeUndefined();
        // ...and no spurious `warning` (the no-menu warning is only emitted when
        // the format is actually requested).
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
  },
);
