import express from "express";
import request from "supertest";
import { deprecationMiddleware, sunsetOf } from "../../lib/deprecations";

// Pre-existing deprecation entries and their replacements. Pinned so the
// github entry cannot change anyone else's wire output. All shipped in #3469
// on 2026-05-06, which is the date they now emit.
const LEGACY_DEPRECATED_AT = "@1778025600";

const EXISTING = {
  v1_extract: "/v2/scrape",
  v1_extract_status: "/v2/scrape",
  v2_extract: "/v2/scrape",
  v2_extract_status: "/v2/scrape",
  v0_scrape: "/v2/scrape",
  v0_crawl: "/v2/crawl",
  v0_crawl_status: "/v2/crawl/:jobId",
  v0_crawl_cancel: "/v2/crawl/:jobId",
  v0_search: "/v2/search",
} as const;

type Key = keyof typeof EXISTING;

const V0_GUIDE = "https://docs.firecrawl.dev/migrating-from-v0";
const V0_SUNSET = "Thu, 10 Dec 2026 15:00:00 GMT";
const EXTRACT_SUNSET = "Thu, 10 Dec 2026 15:00:00 GMT";

// What the old middleware did, replayed on a copy, so we can compare bytes.
function legacyAnnotate(body: any, message: string, replacement?: string) {
  const copy = JSON.parse(JSON.stringify(body));
  const existing = Array.isArray(copy.warnings) ? copy.warnings : [];
  copy.warnings = [...existing, message];
  if (replacement && copy.replacement === undefined) {
    copy.replacement = replacement;
  }
  return JSON.stringify(copy);
}

function appFor(key: Key, body: unknown) {
  const app = express();
  app.get("/probe", deprecationMiddleware(key), (_req, res) => {
    res.status(200).json(body);
  });
  return app;
}

const BODIES: Record<string, unknown> = {
  plain: { success: true, id: "abc" },
  "with existing warnings": { success: true, warnings: ["upstream note"] },
  "with existing replacement": { success: true, replacement: "/keep/me" },
  "warnings first": { warnings: [], success: true },
};

describe("pre-existing deprecated routes are unchanged", () => {
  // Before the v0 and extract sunsets, so every route still serves.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const key of Object.keys(EXISTING) as Key[]) {
    describe(key, () => {
      it("emits the shared 2026-05-06 Deprecation date, and a Sunset only on v0 and extract", async () => {
        const res = await request(appFor(key, BODIES.plain)).get("/probe");

        expect(res.headers["deprecation"]).toBe(LEGACY_DEPRECATED_AT);
        expect(res.headers["sunset"]).toBe(
          key.startsWith("v0_")
            ? V0_SUNSET
            : key.includes("extract")
              ? EXTRACT_SUNSET
              : undefined,
        );
        expect(res.headers["warning"]).toMatch(/^299 - "/);
        if (key.startsWith("v0_")) {
          expect(res.headers["warning"]).toContain(V0_GUIDE);
          expect(res.headers["link"]).toBe(
            `<${V0_GUIDE}>; rel="deprecation", <${EXISTING[key]}>; rel="successor-version"`,
          );
        } else if (EXISTING[key]) {
          const docsLink = key.includes("extract")
            ? `<https://docs.firecrawl.dev/migrating-from-extract>; rel="deprecation", `
            : "";
          expect(res.headers["link"]).toBe(
            `${docsLink}<${EXISTING[key]}>; rel="successor-version"`,
          );
        } else {
          expect(res.headers["link"]).toBeUndefined();
        }
      });

      for (const [label, body] of Object.entries(BODIES)) {
        it(`serialises a ${label} body byte-for-byte as before`, async () => {
          const res = await request(appFor(key, body)).get("/probe");
          const message = res.headers["warning"].replace(/^299 - "|"$/g, "");

          expect(res.text).toBe(legacyAnnotate(body, message, EXISTING[key]));
        });
      }

      it("no longer mutates the object the controller passed in", async () => {
        const body: any = { success: true };
        await request(appFor(key, body)).get("/probe");

        expect(body.warnings).toBeUndefined();
        expect(body.replacement).toBeUndefined();
      });
    });
  }

  it("arrays and strings pass straight through", async () => {
    const arr = await request(appFor("v0_search", [1, 2])).get("/probe");
    expect(arr.text).toBe("[1,2]");
    const str = await request(appFor("v0_search", "hello")).get("/probe");
    expect(str.text).toBe('"hello"');
  });
});

describe("deep-research and llmstxt entries", () => {
  const CASES = {
    v1_deep_research: {
      replacement: "/v2/agent",
      docs: "https://docs.firecrawl.dev/migrating-from-deep-research",
    },
    v1_deep_research_status: {
      replacement: "/v2/agent/:jobId",
      docs: "https://docs.firecrawl.dev/migrating-from-deep-research",
    },
    v1_llmstxt: {
      replacement: undefined,
      docs: "https://docs.firecrawl.dev/migrating-from-llmstxt",
    },
    v1_llmstxt_status: {
      replacement: undefined,
      docs: "https://docs.firecrawl.dev/migrating-from-llmstxt",
    },
  } as const;

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const key of Object.keys(CASES) as (keyof typeof CASES)[]) {
    const { replacement, docs } = CASES[key];

    it(`${key} links its migration guide and replacement`, async () => {
      // Just before the entry's sunset, so the route still serves.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(sunsetOf(key) - 1);
      const app = express();
      app.get("/probe", deprecationMiddleware(key), (_req, res) => {
        res.status(200).json({ success: true });
      });
      const res = await request(app).get("/probe");

      expect(res.headers["deprecation"]).toBe(LEGACY_DEPRECATED_AT);
      expect(res.headers["sunset"]).toBe(new Date(sunsetOf(key)).toUTCString());
      const links = [`<${docs}>; rel="deprecation"`];
      if (replacement) links.push(`<${replacement}>; rel="successor-version"`);
      expect(res.headers["link"]).toBe(links.join(", "));
      expect(res.body.replacement).toBe(replacement);
    });
  }
});
