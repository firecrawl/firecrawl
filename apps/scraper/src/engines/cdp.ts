import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { chromium, type Browser, type BrowserContext } from "playwright";
import TurndownService from "turndown";
import type { ScrapeRequest } from "../client.js";
import type { ScrapeResponseData } from "../formats/types.js";
import type { Engine } from "./types.js";

const DEFAULT_TIMEOUT = 30_000;

const STRIP_SELECTORS: readonly string[] = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "head",
  "meta",
  "link",
  "object",
  "embed",
  "video",
  "audio",
  "canvas",
  "template",
  "nav",
  "footer",
  "header",
  "aside",
  "[role='banner']",
  "[role='navigation']",
  "[role='complementary']",
  "[role='contentinfo']",
  "[class*='ad-']",
  "[class*='-ad']",
  "[id*='ad-']",
  "[id*='-ad']",
  "[class*='modal']",
  "[class*='popup']",
  "[class*='overlay']",
  "[class*='cookie']",
  "[class*='consent']",
  "[class*='gdpr']",
  "[class*='banner']",
  "[class*='subscribe']",
  "[class*='newsletter']",
  "[class*='breadcrumb']",
  "[class*='social']",
  "[class*='share']",
  "[class*='related']",
  "[class*='widget']",
];

export class CdpEngine implements Engine {
  readonly name = "cdp";
  private browser: Browser | null = null;
  private userAgent: string | undefined;
  private readonly turndown = (() => {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    td.remove(["script", "style", "noscript", "iframe", "head", "meta", "link"] as Parameters<
      typeof td.remove
    >[0]);
    td.addRule("svg", { filter: "svg" as never, replacement: () => "" });
    return td;
  })();

  constructor(private readonly cdpUrl: string) {}

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CDP connect failed at ${this.cdpUrl}: ${msg}\n` +
          `Launch Chrome first:\n` +
          `  google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.scraper-chrome" &\n` +
          `Then verify: curl -s ${this.cdpUrl}/json/version`,
      );
    }
    return this.browser;
  }

  private async getContext(browser: Browser): Promise<BrowserContext> {
    const existing = browser.contexts();
    if (existing.length > 0 && existing[0]) return existing[0];
    return browser.newContext();
  }

  /**
   * Run Readability over the cleaned HTML in Node-side JSDOM. Returns
   * extracted article HTML or `null` if the page isn't article-shaped.
   */
  private extractMainContent(html: string, url: string): string | null {
    try {
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      return article?.content ?? null;
    } catch {
      return null;
    }
  }

  async prepare(): Promise<void> {
    await this.ensureBrowser();
  }

  async downloadHeaders(url: string): Promise<Record<string, string>> {
    const context = await this.getContext(await this.ensureBrowser());
    const cookies = await context.cookies(url);
    const headers: Record<string, string> = {};
    if (cookies.length > 0)
      headers["Cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    if (this.userAgent) headers["User-Agent"] = this.userAgent;
    return headers;
  }

  async scrape(req: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponseData> {
    const browser = await this.ensureBrowser();
    const context = await this.getContext(browser);
    const page = await context.newPage();
    const abort = (): void => {
      void page.close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      // tsx/esbuild injects a `__name` helper for class-name preservation; when
      // Playwright serializes our evaluate() callbacks via .toString(), the
      // helper calls get carried into the browser where __name is undefined.
      // Shim it as a no-op before any page script runs.
      await page.addInitScript(() => {
        const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
        if (!g.__name) g.__name = (fn) => fn;
      });
      if (req.headers && Object.keys(req.headers).length > 0) {
        await page.setExtraHTTPHeaders(req.headers);
      }
      const response = await page.goto(req.url, {
        waitUntil: "domcontentloaded",
        timeout: req.timeout ?? DEFAULT_TIMEOUT,
      });
      if (req.waitFor && req.waitFor > 0) {
        await page.waitForTimeout(req.waitFor);
      }

      const warnings: string[] = [];
      const readyTimeout = req.timeout && req.timeout > 0 ? req.timeout : DEFAULT_TIMEOUT;
      const readyDeadline = Date.now() + readyTimeout;
      const remaining = (): number => Math.max(1, readyDeadline - Date.now());
      try {
        await page.waitForLoadState("networkidle", { timeout: remaining() });
        // A full-page screenshot includes below-fold images, which lazy loading
        // otherwise leaves blank without issuing their requests.
        await page.evaluate(() => {
          for (const image of document.images) image.loading = "eager";
        });
        await page.waitForFunction(
          () =>
            (!document.fonts || document.fonts.status === "loaded") &&
            [...document.images].every((image) => image.complete),
          undefined,
          { timeout: remaining() },
        );
      } catch (err) {
        signal?.throwIfAborted();
        if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
        warnings.push(
          `Page readiness timed out after ${readyTimeout} ms; some content may still be loading.`,
        );
      }

      const rawHtml = await page.content();
      const wantedFormats = new Set(req.formats ?? ["markdown"]);
      const out: ScrapeResponseData = {};
      const meta = await page.evaluate(() => {
        const get = (sel: string): string | undefined =>
          (document.querySelector(sel) as HTMLMetaElement | null)?.content ?? undefined;
        return {
          title: document.title || undefined,
          description: get('meta[name="description"]'),
          ogTitle: get('meta[property="og:title"]'),
          ogDescription: get('meta[property="og:description"]'),
        };
      });
      this.userAgent = await page.evaluate(() => navigator.userAgent);
      out.metadata = {
        ...meta,
        sourceURL: req.url,
        url: page.url(),
        statusCode: response?.status() ?? null,
        retryAfter: response?.headers()["retry-after"],
        captureReady: warnings.length === 0,
      };
      if (wantedFormats.has("links")) {
        out.links = await page.evaluate(() =>
          [
            ...new Set(
              [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href),
            ),
          ].filter((h) => /^https?:/.test(h)),
        );
      }
      if (wantedFormats.has("screenshot")) {
        try {
          const buf = await page.screenshot({
            fullPage: true,
            type: "png",
            animations: "disabled",
          });
          out.screenshot = `data:image/png;base64,${buf.toString("base64")}`;
        } catch (err) {
          signal?.throwIfAborted();
          warnings.push(
            `Screenshot unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Strip noise nodes + dangerous attributes in the live DOM, then read
      // the cleaned HTML back out. Mirrors removeUnwantedElements.ts in the API.
      await page.evaluate((selectors: string[]) => {
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) el.remove();
        }
        for (const el of document.querySelectorAll("*")) {
          // Snapshot first — removing during live NamedNodeMap iteration skips entries.
          const names = Array.from(el.attributes, (a) => a.name);
          for (const name of names) {
            if (name.startsWith("on") || name === "style") {
              el.removeAttribute(name);
            }
          }
        }
      }, STRIP_SELECTORS as string[]);

      const cleanedHtml = await page.content();
      let html = cleanedHtml;
      if (req.onlyMainContent) {
        const article = this.extractMainContent(cleanedHtml, req.url);
        if (article) {
          html = article;
        } else {
          // Readability didn't recognize the page as article-shaped; fall back
          // to a structural selector so we still narrow the scope.
          const fallback = await page.evaluate(() => {
            const node =
              document.querySelector("main") ??
              document.querySelector("article") ??
              document.querySelector("[role='main']");
            return node?.outerHTML ?? null;
          });
          if (fallback) html = fallback;
        }
      }

      if (wantedFormats.has("html")) out.html = html;
      if (wantedFormats.has("rawHtml")) out.rawHtml = rawHtml;
      if (wantedFormats.has("markdown")) out.markdown = this.turndown.turndown(html);

      if (warnings.length > 0) out["warning"] = warnings.join(" ");
      return out;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!page.isClosed()) await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      await this.browser.close();
    }
    this.browser = null;
  }
}
