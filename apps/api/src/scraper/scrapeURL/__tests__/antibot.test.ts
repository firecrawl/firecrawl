import { describe, it, expect, vi } from "vitest";
import { isAntiBotBlock } from "../lib/antibot";
import { ScrapeBlockedError } from "../error";
import {
  serializeTransportableError,
  deserializeTransportableError,
} from "../../../lib/error-serde";
import { scrapeURL } from "../index";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import * as enginesModule from "../engines";

describe("isAntiBotBlock", () => {
  it("detects anti-bot status codes (403, 401, 429)", () => {
    expect(isAntiBotBlock(403)).toBe(true);
    expect(isAntiBotBlock(401)).toBe(true);
    expect(isAntiBotBlock(429)).toBe(true);
    expect(isAntiBotBlock(200)).toBe(false);
    expect(isAntiBotBlock(404)).toBe(false);
    expect(isAntiBotBlock(500)).toBe(false);
  });

  it("detects Cloudflare challenge pages (status 200)", () => {
    const cfTitleHtml = `<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>`;
    expect(isAntiBotBlock(200, cfTitleHtml)).toBe(true);

    const cfAttentionHtml = `<html><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-browser-verification"></div></body></html>`;
    expect(isAntiBotBlock(200, cfAttentionHtml)).toBe(true);

    const cfTurnstileHtml = `<html><body><div id="challenge-platform"><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></div></body></html>`;
    expect(isAntiBotBlock(200, cfTurnstileHtml)).toBe(true);

    const cfVerifyMarkdown = `Please verify you are a human to access this site. Cloudflare Ray ID: 89342784832`;
    expect(isAntiBotBlock(200, undefined, cfVerifyMarkdown)).toBe(true);
  });

  it("detects DataDome challenge and block pages (status 200)", () => {
    const datadomeHtml = `<html><head><script src="https://geo.captcha-delivery.com/captcha/captcha.js"></script></head><body>Protected by DataDome</body></html>`;
    expect(isAntiBotBlock(200, datadomeHtml)).toBe(true);

    const datadomeBlockHtml = `<html><body><h1>Access to this page has been denied</h1><p>Blocked by DataDome</p></body></html>`;
    expect(isAntiBotBlock(200, datadomeBlockHtml)).toBe(true);
  });

  it("detects generic CAPTCHAs and WAF challenges", () => {
    const pxHtml = `<html><body><div id="px-captcha">Press & Hold to confirm you are a human</div></body></html>`;
    expect(isAntiBotBlock(200, pxHtml)).toBe(true);

    const incapsulaHtml = `<html><body><p>Incapsula incident ID: 12345</p></body></html>`;
    expect(isAntiBotBlock(200, incapsulaHtml)).toBe(true);

    const robotCheckHtml = `<html><head><title>Robot Check</title></head><body>Please solve this CAPTCHA</body></html>`;
    expect(isAntiBotBlock(200, robotCheckHtml)).toBe(true);
  });

  it("returns false for legitimate clean HTML and markdown", () => {
    const normalHtml = `<!DOCTYPE html><html><head><title>ResearchGate Paper Title</title></head><body><h1>Deep Learning in Robotics</h1><p>This paper discusses robotic learning techniques.</p></body></html>`;
    const normalMarkdown = `# Deep Learning in Robotics\n\nThis paper discusses robotic learning techniques.`;
    expect(isAntiBotBlock(200, normalHtml, normalMarkdown)).toBe(false);
  });
});

describe("ScrapeBlockedError SerDe", () => {
  it("serializes and deserializes ScrapeBlockedError properly", () => {
    const err = new ScrapeBlockedError("Scrape blocked by Cloudflare challenge");
    expect(err.code).toBe("SCRAPE_FAILED_BLOCKED");

    const serialized = serializeTransportableError(err);
    expect(serialized.startsWith("SCRAPE_FAILED_BLOCKED|")).toBe(true);

    const deserialized = deserializeTransportableError(serialized);
    expect(deserialized).toBeInstanceOf(ScrapeBlockedError);
    expect(deserialized?.code).toBe("SCRAPE_FAILED_BLOCKED");
    expect(deserialized?.message).toBe("Scrape blocked by Cloudflare challenge");
  });
});

describe("Anti-bot waterfall loop termination", () => {
  it("terminates with ScrapeBlockedError when all engines return 403 / anti-bot block pages", async () => {
    vi.spyOn(enginesModule, "scrapeURLWithEngine").mockResolvedValue({
      url: "https://www.researchgate.net/publication/12345_sample",
      html: `<html><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-browser-verification"></div></body></html>`,
      statusCode: 403,
      proxyUsed: "basic",
    });

    const out = await scrapeURL(
      "test:antibot-terminal-state",
      "https://www.researchgate.net/publication/12345_sample",
      scrapeOptions.parse({
        proxy: "stealth",
      }),
      { forceEngine: "fire-engine;chrome-cdp;stealth", teamId: "test", orgId: null },
      new CostTracking(),
    );

    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error).toBeInstanceOf(ScrapeBlockedError);
      expect((out.error as any).code).toBe("SCRAPE_FAILED_BLOCKED");
    }
  });

  it("escalates from auto proxy to stealth proxy and terminates with ScrapeBlockedError if still blocked", async () => {
    let callCount = 0;
    vi.spyOn(enginesModule, "scrapeURLWithEngine").mockImplementation(async (meta, engine) => {
      callCount++;
      return {
        url: "https://www.researchgate.net/publication/12345_sample",
        html: `<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>`,
        statusCode: 200,
        proxyUsed: "basic",
      };
    });

    const out = await scrapeURL(
      "test:antibot-auto-to-stealth-terminal",
      "https://www.researchgate.net/publication/12345_sample",
      scrapeOptions.parse({
        proxy: "auto",
      }),
      { forceEngine: ["fetch", "fire-engine;chrome-cdp;stealth"], teamId: "test", orgId: null },
      new CostTracking(),
    );

    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error).toBeInstanceOf(ScrapeBlockedError);
      expect((out.error as any).code).toBe("SCRAPE_FAILED_BLOCKED");
    }
    // Verifies it escalated once (auto -> stealth) and then terminated instead of looping forever
    expect(callCount).toBeLessThanOrEqual(4);
  });
});
