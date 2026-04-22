import crypto from "crypto";
import { chromium, type Browser } from "playwright";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_PLAYWRIGHT,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  describeIf,
  itIf,
} from "../lib";
import {
  Identity,
  createLocalBrowserRaw,
  deleteLocalBrowserRaw,
  idmux,
  scrape,
  scrapeRaw,
  scrapeTimeout,
} from "./lib";

let identity: Identity;
let otherIdentity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "local-browser",
    concurrency: 20,
    credits: 1_000_000,
  });
  otherIdentity = await idmux({
    name: "local-browser-other",
    concurrency: 10,
    credits: 1_000_000,
  });
}, 10000 + scrapeTimeout);

describeIf(HAS_PLAYWRIGHT && ALLOW_TEST_SUITE_WEBSITE)(
  "Local browser session (playwright-service backed)",
  () => {
    it(
      "scrapes the current DOM of a playwright-driven page without re-navigating",
      async () => {
        const createResp = await createLocalBrowserRaw(identity);
        expect(createResp.statusCode).toBe(200);
        expect(createResp.body.success).toBe(true);
        expect(typeof createResp.body.id).toBe("string");
        expect(typeof createResp.body.cdp_url).toBe("string");

        const { id, cdp_url } = createResp.body;
        const marker = `MARKER_${crypto.randomUUID()}`;

        try {
          // Do NOT call browser.close() in cleanup: on a CDP-attached Playwright
          // Browser, close() sends a Browser.close CDP command that terminates
          // the remote Chromium and wipes the session. The Jest process exit
          // tears down the WebSocket for us; deleteLocalBrowserRaw below is
          // the authoritative cleanup.
          const browser: Browser = await chromium.connectOverCDP(cdp_url);
          const ctx = browser.contexts()[0] ?? (await browser.newContext());
          const page = ctx.pages()[0] ?? (await ctx.newPage());

          await page.goto(TEST_SUITE_WEBSITE, { waitUntil: "load" });

          // Mutate DOM + localStorage client-side. If the server re-navigated,
          // the marker would disappear because goto would reload the page.
          await page.evaluate(m => {
            document.body.setAttribute("data-firecrawl-marker", m);
            const div = document.createElement("div");
            div.id = "firecrawl-session-marker";
            div.textContent = m;
            document.body.appendChild(div);
            try {
              window.localStorage.setItem("firecrawl_marker", m);
            } catch {}
          }, marker);

          const doc = await scrape(
            {
              sessionId: id,
              formats: ["markdown", "rawHtml"],
            } as any,
            identity,
          );

          expect(typeof doc.rawHtml).toBe("string");
          expect(doc.rawHtml).toContain(marker);
          expect(typeof doc.markdown).toBe("string");
          expect(doc.markdown!.length).toBeGreaterThan(0);
        } finally {
          await deleteLocalBrowserRaw(id, identity);
        }
      },
      scrapeTimeout,
    );

    it(
      "reflects SPA-style interactions in the scrape (post-click DOM is captured)",
      async () => {
        const createResp = await createLocalBrowserRaw(identity);
        expect(createResp.statusCode).toBe(200);
        const { id, cdp_url } = createResp.body;
        const marker = `POST_CLICK_${crypto.randomUUID()}`;

        try {
          // See note above: no browser.close() on a CDP-attached Browser.
          const browser: Browser = await chromium.connectOverCDP(cdp_url);
          const ctx = browser.contexts()[0] ?? (await browser.newContext());
          const page = ctx.pages()[0] ?? (await ctx.newPage());

          await page.goto(TEST_SUITE_WEBSITE, { waitUntil: "load" });

          // Simulate an SPA-style state transition driven by the client: inject
          // a button, click it, and wait for a selector that only appears after.
          await page.evaluate(m => {
            const btn = document.createElement("button");
            btn.id = "firecrawl-spa-btn";
            btn.textContent = "Next step";
            btn.addEventListener("click", () => {
              const panel = document.createElement("div");
              panel.id = "details-panel";
              panel.className = "loaded";
              panel.textContent = m;
              document.body.appendChild(panel);
            });
            document.body.appendChild(btn);
          }, marker);

          await page.click("#firecrawl-spa-btn");
          await page.waitForSelector("#details-panel.loaded");

          const doc = await scrape(
            {
              sessionId: id,
              formats: ["rawHtml"],
            } as any,
            identity,
          );

          expect(doc.rawHtml).toContain(marker);
          expect(doc.rawHtml).toContain("details-panel");
        } finally {
          await deleteLocalBrowserRaw(id, identity);
        }
      },
      scrapeTimeout,
    );

    it(
      "supports multiple scrapes across one CDP connection without browser.close()",
      async () => {
        const createResp = await createLocalBrowserRaw(identity);
        expect(createResp.statusCode).toBe(200);
        const { id, cdp_url } = createResp.body;
        const markerA = `A_${crypto.randomUUID()}`;
        const markerB = `B_${crypto.randomUUID()}`;

        try {
          const browser: Browser = await chromium.connectOverCDP(cdp_url);
          const ctx = browser.contexts()[0] ?? (await browser.newContext());
          const page = ctx.pages()[0] ?? (await ctx.newPage());

          await page.goto(TEST_SUITE_WEBSITE, { waitUntil: "load" });

          // First mutation + first scrape.
          await page.evaluate(m => {
            const div = document.createElement("div");
            div.id = "firecrawl-marker-a";
            div.textContent = m;
            document.body.appendChild(div);
          }, markerA);

          const docA = await scrape(
            {
              sessionId: id,
              formats: ["rawHtml"],
            } as any,
            identity,
          );
          expect(docA.rawHtml).toContain(markerA);
          expect(docA.rawHtml).not.toContain(markerB);

          // Mutate the SAME page again and re-scrape via the SAME session.
          // If the server re-navigated between scrapes, marker A would be
          // wiped; if the CDP session was broken, this scrape would 404.
          await page.evaluate(m => {
            const div = document.createElement("div");
            div.id = "firecrawl-marker-b";
            div.textContent = m;
            document.body.appendChild(div);
          }, markerB);

          const docB = await scrape(
            {
              sessionId: id,
              formats: ["rawHtml"],
            } as any,
            identity,
          );
          expect(docB.rawHtml).toContain(markerA);
          expect(docB.rawHtml).toContain(markerB);
        } finally {
          await deleteLocalBrowserRaw(id, identity);
        }
      },
      scrapeTimeout,
    );

    it(
      "returns 404 when scraping a session after delete_local_browser",
      async () => {
        const createResp = await createLocalBrowserRaw(identity);
        expect(createResp.statusCode).toBe(200);
        const { id, cdp_url } = createResp.body;

        const browser: Browser = await chromium.connectOverCDP(cdp_url);
        const ctx = browser.contexts()[0] ?? (await browser.newContext());
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto(TEST_SUITE_WEBSITE, { waitUntil: "load" });

        // Baseline: scraping the live session works.
        const baseline = await scrapeRaw(
          {
            sessionId: id,
            formats: ["markdown"],
          } as any,
          identity,
        );
        expect(baseline.statusCode).toBe(200);
        expect(baseline.body.success).toBe(true);

        // Authoritative cleanup path: the API delete endpoint.
        const del = await deleteLocalBrowserRaw(id, identity);
        expect(del.statusCode).toBe(200);
        expect(del.body.success).toBe(true);

        // After delete, subsequent scrapes with the same sessionId must 404.
        const afterDelete = await scrapeRaw(
          {
            sessionId: id,
            formats: ["markdown"],
          } as any,
          identity,
        );
        expect(afterDelete.statusCode).toBe(404);
        expect(afterDelete.body.success).toBe(false);
      },
      scrapeTimeout,
    );

    it(
      "returns 403 when another team tries to scrape a session it doesn't own",
      async () => {
        const createResp = await createLocalBrowserRaw(identity);
        expect(createResp.statusCode).toBe(200);
        const { id } = createResp.body;

        try {
          const raw = await scrapeRaw(
            {
              sessionId: id,
              formats: ["markdown"],
            } as any,
            otherIdentity,
          );

          expect(raw.statusCode).toBe(403);
          expect(raw.body.success).toBe(false);
        } finally {
          await deleteLocalBrowserRaw(id, identity);
        }
      },
      scrapeTimeout,
    );

    it(
      "returns 404 when scraping with an unknown sessionId",
      async () => {
        const raw = await scrapeRaw(
          {
            sessionId: crypto.randomUUID(),
            formats: ["markdown"],
          } as any,
          identity,
        );

        expect(raw.statusCode).toBe(404);
        expect(raw.body.success).toBe(false);
      },
      scrapeTimeout,
    );

    it("returns 404 when deleting an unknown sessionId", async () => {
      const resp = await deleteLocalBrowserRaw(crypto.randomUUID(), identity);
      expect(resp.statusCode).toBe(404);
      expect(resp.body.success).toBe(false);
    });
  },
);

// This failure path only applies to a self-hosted deployment that has NOT
// configured the playwright microservice. When fire-engine is in use, a
// local-browser endpoint is still unavailable, so the 400 semantics apply.
itIf(TEST_SELF_HOST && !HAS_PLAYWRIGHT)(
  "rejects local-browser create when PLAYWRIGHT_MICROSERVICE_URL is not configured",
  async () => {
    const resp = await createLocalBrowserRaw(identity);
    expect(resp.statusCode).toBe(400);
    expect(resp.body.success).toBe(false);
    expect(typeof resp.body.error).toBe("string");
  },
);
