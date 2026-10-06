import {
  type CostTrackingCall,
  getCostTrackingCalls,
} from "../cost-tracking-helpers";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  HAS_AI,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  scrape,
  scrapeTimeout,
  scrapeWithFailure,
  idmux,
  Identity,
} from "./lib";

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

const isBrandingCall = (call: CostTrackingCall) =>
  call.metadata?.module === "branding" &&
  call.metadata?.method === "enhanceBrandingWithLLM";

// Whether the server could route a test team's branding to Jev (all teams, a
// listed team, or a rollout share). The LLM-only assertion below only holds
// when none of these is configured.
const JEV_MAY_APPLY =
  !!process.env.TYPESAFE_API_KEY &&
  (process.env.BRANDING_JEV === "true" ||
    !!process.env.BRANDING_JEV_TEAM_IDS?.trim() ||
    Number(process.env.BRANDING_JEV_ROLLOUT_PERCENT || 0) > 0);

describe("Branding cost tracking", () => {
  concurrentIf(TEST_PRODUCTION && !JEV_MAY_APPLY)(
    "records the branding LLM call with its model and cost",
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

      const calls = await getCostTrackingCalls(response.metadata.scrapeId!);
      const brandingCalls = calls.filter(isBrandingCall);

      expect(brandingCalls).toHaveLength(1);
      expect(brandingCalls[0].model).toMatch(/^gpt-4o/);
      expect(brandingCalls[0].tokens?.input).toBeGreaterThan(0);
      expect(brandingCalls[0].cost).toBeGreaterThan(0);
    },
    scrapeTimeout + 15000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "records no branding call when branding is not requested",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl-test-site.vercel.app/branding-declared-only",
          formats: ["markdown"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      const calls = await getCostTrackingCalls(response.metadata.scrapeId!);

      expect(calls.filter(isBrandingCall)).toHaveLength(0);
    },
    scrapeTimeout + 15000,
  );
});

// Runs when the API server was started with TYPESAFE_API_KEY and
// BRANDING_JEV=true, which puts every team (including test identities, whose
// ids aren't known ahead of time) on Jev.
const JEV_ON =
  !!process.env.TYPESAFE_API_KEY && process.env.BRANDING_JEV === "true";

describe("Branding with Jev", () => {
  concurrentIf(TEST_PRODUCTION && JEV_ON)(
    "answers branding with Jev and records its cost, not an LLM call",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl-test-site.vercel.app/",
          formats: ["branding"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.branding).toBeDefined();
      expect(response.branding?.logo).toContain("firecrawl");
      expect(response.branding?.colors?.primary).toMatch(/^#[0-9A-F]{6}$/);

      const calls = await getCostTrackingCalls(response.metadata.scrapeId!);
      const jevCalls = calls.filter(
        call =>
          call.metadata?.module === "branding" &&
          call.metadata?.method === "enhanceBrandingWithJev",
      );
      expect(jevCalls).toHaveLength(1);
      expect(jevCalls[0].model).toMatch(/^jev/);
      expect(jevCalls[0].cost).toBeGreaterThan(0);
      expect(calls.filter(isBrandingCall)).toHaveLength(0);
    },
    scrapeTimeout + 15000,
  );
});

describe("Branding response", () => {
  concurrentIf(TEST_PRODUCTION)(
    "returns no internal fields to teams that aren't debugging branding",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl-test-site.vercel.app/",
          formats: ["branding"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.branding).toBeDefined();
      // Still a real extraction, not an empty object.
      expect(response.branding?.logo).toContain("firecrawl");
      expect(response.branding?.colors?.primary).toMatch(/^#[0-9A-F]{6}$/);
      expect(
        Object.keys(response.branding!).filter(key => key.startsWith("__")),
      ).toEqual([]);
    },
    scrapeTimeout,
  );
});

const PDF_URL = "https://www.orimi.com/pdf-test.pdf";

describe("Branding on pages it can't run on", () => {
  concurrentIf(TEST_PRODUCTION)(
    "keeps the other formats and warns when the page is a PDF",
    async () => {
      const response = await scrape(
        {
          url: PDF_URL,
          formats: ["markdown", "branding"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown?.length).toBeGreaterThan(0);
      expect(response.branding).toBeUndefined();
      expect(response.warning).toContain("Branding was skipped");
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION)(
    "still fails a branding-only request for a PDF",
    async () => {
      const response = await scrapeWithFailure(
        { url: PDF_URL, formats: ["branding"], timeout: scrapeTimeout },
        identity,
      );

      expect(response.error).toContain(
        "Branding extraction is only supported for HTML web pages",
      );
    },
    scrapeTimeout,
  );

  // Self-hosted has no fire-engine, so branding can never run there.
  concurrentIf(TEST_SELF_HOST && ALLOW_TEST_SUITE_WEBSITE)(
    "keeps the other formats when branding can't run self-hosted",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: ["markdown", "branding"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown?.length).toBeGreaterThan(0);
      expect(response.branding).toBeUndefined();
      expect(response.warning).toContain("Branding was skipped");
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
