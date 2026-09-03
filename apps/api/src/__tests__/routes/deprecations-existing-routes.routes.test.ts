import express from "express";
import request from "supertest";
import { deprecationMiddleware } from "../../lib/deprecations";

// Every pre-existing deprecation entry, and what a client saw from it before
// the middleware learned about per-entry dates and stopped mutating bodies.
// Pinned so the github entry cannot change anyone else's wire output.
const EXISTING = {
  v1_extract: "/v2/scrape",
  v1_extract_status: "/v2/scrape",
  v2_extract: "/v2/scrape",
  v2_extract_status: "/v2/scrape",
  v1_deep_research: "/v2/search",
  v1_deep_research_status: "/v2/search",
  v1_llmstxt: undefined,
  v1_llmstxt_status: undefined,
  v0_scrape: "/v2/scrape",
  v0_crawl: "/v2/crawl",
  v0_crawl_status: "/v2/crawl/:jobId",
  v0_crawl_cancel: "/v2/crawl/:jobId",
  v0_search: "/v2/search",
} as const;

type Key = keyof typeof EXISTING;

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
  for (const key of Object.keys(EXISTING) as Key[]) {
    describe(key, () => {
      it("still emits Deprecation: true and no Sunset", async () => {
        const res = await request(appFor(key, BODIES.plain)).get("/probe");

        expect(res.headers["deprecation"]).toBe("true");
        expect(res.headers["sunset"]).toBeUndefined();
        expect(res.headers["warning"]).toMatch(/^299 - "/);
        if (EXISTING[key]) {
          expect(res.headers["link"]).toBe(
            `<${EXISTING[key]}>; rel="successor-version"`,
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
  });
});
