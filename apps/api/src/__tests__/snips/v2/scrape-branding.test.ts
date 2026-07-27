import { concurrentIf, HAS_AI, TEST_PRODUCTION } from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-branding",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describe("Branding declared-logo fallback", () => {
  // The fixture page declares its logo via JSON-LD + apple-touch icon but
  // renders no logo image in the DOM, forcing the declared-mark fallback.
  concurrentIf(TEST_PRODUCTION)(
    "uses the JSON-LD declared logo when the DOM has none",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl-test-site.vercel.app/branding-declared-only",
          formats: ["branding"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.branding).toBeDefined();
      expect(response.branding?.images?.logo).toBe(
        "https://firecrawl-test-site.vercel.app/declared-logo.png",
      );
    },
    scrapeTimeout,
  );
});

// TODO: fix this test
// Need to run on fire-engine
describe.skip("Branding extraction", () => {
  describe("Basic branding extraction", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts branding with required fields",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding).toBeDefined();
        expect(response.branding?.colors).toBeDefined();
        expect(response.branding?.typography).toBeDefined();
        expect(response.branding?.spacing).toBeDefined();
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes color palette with valid colors",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.colors).toBeDefined();
        expect(response.branding?.colors?.primary).toBeDefined();
        expect(response.branding?.colors?.accent).toBeDefined();

        // Check that colors are valid hex or rgba format
        const colorRegex = /^(#[A-F0-9]{6}|rgba?\([^)]+\))$/i;
        if (response.branding?.colors?.primary) {
          expect(response.branding.colors.primary).toMatch(colorRegex);
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes typography information",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.typography).toBeDefined();
        expect(response.branding?.typography?.fontFamilies).toBeDefined();
        expect(
          response.branding?.typography?.fontFamilies?.primary,
        ).toBeDefined();
        expect(
          typeof response.branding?.typography?.fontFamilies?.primary,
        ).toBe("string");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes spacing information",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.spacing).toBeDefined();
        expect(response.branding?.spacing?.baseUnit).toBeDefined();
        expect(typeof response.branding?.spacing?.baseUnit).toBe("number");
        expect(response.branding?.spacing?.baseUnit).toBeGreaterThan(0);
        expect(response.branding?.spacing?.baseUnit).toBeLessThanOrEqual(128);
      },
      scrapeTimeout,
    );
  });

  describe("Component extraction", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts button components",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.components).toBeDefined();

        // At least primary or secondary button should be present
        const hasPrimary = response.branding?.components?.buttonPrimary;
        const hasSecondary = response.branding?.components?.buttonSecondary;
        expect(hasPrimary || hasSecondary).toBeTruthy();

        if (hasPrimary) {
          expect(
            response.branding?.components?.buttonPrimary?.background,
          ).toBeDefined();
          expect(
            response.branding?.components?.buttonPrimary?.textColor,
          ).toBeDefined();
          expect(
            response.branding?.components?.buttonPrimary?.borderRadius,
          ).toBeDefined();
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts border radius correctly",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        if (response.branding?.components?.buttonPrimary?.borderRadius) {
          const radiusMatch =
            response.branding.components.buttonPrimary.borderRadius.match(
              /^(\d+(\.\d+)?)(px|rem|em)$/,
            );
          expect(radiusMatch).toBeTruthy();
        }
      },
      scrapeTimeout,
    );
  });

  describe("Image extraction", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts logo when present",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.images).toBeDefined();

        // Logo might not always be present, but if it is, should be valid URL or data URL
        if (response.branding?.images?.logo) {
          expect(
            response.branding.images.logo.startsWith("http") ||
              response.branding.images.logo.startsWith("data:"),
          ).toBe(true);
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts favicon when present",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        // Favicon should almost always be present
        if (response.branding?.images?.favicon) {
          expect(
            response.branding.images.favicon.startsWith("http") ||
              response.branding.images.favicon.startsWith("data:"),
          ).toBe(true);
        }
      },
      scrapeTimeout,
    );
  });

  describe("LLM enhancement", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes LLM-enhanced fields",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        // LLM-enhanced fields should be present
        expect(response.branding?.personality).toBeDefined();
        // Note: confidence and designSystem are internal only, not in API response
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes cleaned fonts from LLM",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.fonts).toBeDefined();
        expect(Array.isArray(response.branding?.fonts)).toBe(true);

        // Check that fonts have expected structure if present
        if (response.branding?.fonts && response.branding.fonts.length > 0) {
          const font = response.branding.fonts[0];
          expect(font.family).toBeDefined();
          expect(typeof font.family).toBe("string");

          // Font should not have Next.js obfuscation patterns
          expect(font.family).not.toMatch(/__\w+_[a-f0-9]{8}/i);
        }
      },
      scrapeTimeout,
    );
  });

  describe("Color scheme detection", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "detects color scheme",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        // Color scheme should be detected
        if (response.branding?.colorScheme) {
          expect(["light", "dark"]).toContain(response.branding.colorScheme);
        }
      },
      scrapeTimeout,
    );
  });

  describe("Multiple formats compatibility", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "works alongside other formats",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["markdown", "branding"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.branding).toBeDefined();
        expect(typeof response.markdown).toBe("string");
        expect(typeof response.branding).toBe("object");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "does not interfere with screenshot",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding", "screenshot"],
          },
          identity,
        );

        expect(response.branding).toBeDefined();
        expect(response.screenshot).toBeDefined();
        expect(typeof response.screenshot).toBe("string");
      },
      scrapeTimeout,
    );
  });

  describe("SVG logo handling", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "converts SVG elements to data URLs",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        if (response.branding?.images?.logo?.startsWith("data:image/svg")) {
          // Should be a valid SVG data URL
          expect(response.branding.images.logo).toContain("svg");
          expect(
            response.branding.images.logo.startsWith("data:image/svg+xml"),
          ).toBe(true);
        }
      },
      scrapeTimeout,
    );
  });
});
