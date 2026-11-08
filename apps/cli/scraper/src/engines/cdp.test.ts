import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { connectOverCDP: connect } }));
import { CdpEngine } from "./cdp.js";

function fixture() {
  const dom = new JSDOM(
    `<html><head><title>Original title</title>
    <meta name="description" content="Original description"></head>
    <body><nav><a href="/next">Next</a></nav><main>Hello</main>
    <video src="/clip.mp4"></video></body></html>`,
    {
      url: "https://example.com/",
      runScripts: "outside-only",
    },
  );
  dom.window.eval("globalThis.__name = (fn) => fn");
  let closed = false;
  const handlers: Record<string, (value: unknown) => void> = {};
  const playButton = { isVisible: vi.fn().mockResolvedValue(true), click: vi.fn() };
  const controls = { count: vi.fn().mockResolvedValue(0), nth: vi.fn(() => playButton) };
  const page = {
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      handlers[event] = handler;
    }),
    getByRole: vi.fn(() => ({ or: () => controls })),
    locator: vi.fn(() => ({})),
    addInitScript: vi.fn(),
    setExtraHTTPHeaders: vi.fn(),
    goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
    waitForLoadState: vi.fn(),
    waitForFunction: vi.fn(),
    content: vi.fn(async () => dom.serialize()),
    evaluate: vi.fn(async (fn: Function, arg?: unknown) =>
      dom.window.Function("arg", `return (${fn.toString()})(arg)`)(arg),
    ),
    screenshot: vi.fn(async () => {
      expect(dom.window.document.querySelector("nav")).not.toBeNull();
      expect(dom.window.document.querySelector("video")).not.toBeNull();
      return Buffer.from("png");
    }),
    url: () => "https://example.com/",
    isClosed: () => closed,
    close: vi.fn(async () => {
      closed = true;
    }),
  };
  const cookies = vi.fn().mockResolvedValue([{ name: "session", value: "secret" }]);
  const context = { newPage: vi.fn().mockResolvedValue(page), cookies };
  const browser = { contexts: () => [context], isConnected: () => true, close: vi.fn() };
  connect.mockResolvedValue(browser);
  const respond = (url: string, contentType: string, resourceType = "media"): void =>
    handlers["response"]?.({
      url: () => url,
      headers: () => ({ "content-type": contentType }),
      request: () => ({ resourceType: () => resourceType }),
    });
  return { page, cookies, context, browser, dom, controls, playButton, respond };
}

beforeEach(() => {
  connect.mockReset();
});

describe("CDP capture", () => {
  it("captures metadata, navigation links, raw HTML and screenshot before cleanup", async () => {
    const { page, context, browser, dom } = fixture();
    const engine = new CdpEngine("http://localhost:9222");
    const data = await engine.scrape({
      url: "https://example.com/",
      formats: ["markdown", "html", "rawHtml", "links", "screenshot"],
    });
    expect(data.metadata).toMatchObject({
      title: "Original title",
      description: "Original description",
    });
    expect(data.links).toEqual(["https://example.com/next"]);
    expect(data.rawHtml).toContain("clip.mp4");
    expect(data.html).not.toContain("<nav>");
    expect(data.screenshot).toBe("data:image/png;base64,cG5n");
    expect(page.close).toHaveBeenCalledOnce();
    expect(context.newPage).toHaveBeenCalledOnce();
    await engine.close();
    expect(browser.close).toHaveBeenCalledOnce();
    dom.window.close();
  });

  it("waits for request completion and images before capturing hydrated content", async () => {
    const { page, dom } = fixture();
    page.waitForLoadState.mockImplementation(async () => {
      dom.window.document.querySelector("main")!.textContent = "Loaded test cards";
    });
    page.waitForFunction.mockImplementation(async () => {
      expect(page.waitForLoadState).toHaveBeenCalledWith(
        "networkidle",
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });
    const data = await new CdpEngine("http://localhost:9222").scrape({
      url: "https://example.com/",
      formats: ["markdown", "rawHtml", "screenshot"],
    });
    expect(data.markdown).toContain("Loaded test cards");
    expect(data.rawHtml).toContain("Loaded test cards");
    expect(data.metadata?.["captureReady"]).toBe(true);
    expect(page.screenshot).toHaveBeenCalledWith({
      fullPage: true,
      type: "png",
      animations: "disabled",
    });
    dom.window.close();
  });

  it("bounds readiness waiting and records timeouts without discarding content", async () => {
    const { page, dom } = fixture();
    const timeout = new Error("still polling");
    timeout.name = "TimeoutError";
    page.waitForLoadState.mockRejectedValue(timeout);
    const data = await new CdpEngine("http://localhost:9222").scrape({
      url: "https://example.com/",
      formats: ["markdown", "screenshot"],
      timeout: 50,
    });
    expect(data.metadata?.["captureReady"]).toBe(false);
    expect(data["warning"]).toMatch(/readiness timed out after 50 ms/);
    expect(data.markdown).toContain("Hello");
    expect(page.waitForFunction).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledOnce();
    dom.window.close();
  });

  it("scopes download cookies to the requested destination", async () => {
    const { cookies, dom } = fixture();
    const engine = new CdpEngine("http://localhost:9222");
    await engine.prepare();
    expect(await engine.downloadHeaders("https://cdn.example.com/image.png")).toEqual({
      Cookie: "session=secret",
    });
    expect(cookies).toHaveBeenCalledWith("https://cdn.example.com/image.png");
    dom.window.close();
  });

  it("keeps content when a screenshot fails", async () => {
    const { page, dom } = fixture();
    page.screenshot.mockRejectedValueOnce(new Error("unsupported"));
    const engine = new CdpEngine("http://localhost:9222");
    const data = await engine.scrape({
      url: "https://example.com/",
      formats: ["markdown", "screenshot"],
    });
    expect(data.markdown).toContain("Hello");
    expect(data["warning"]).toContain("unsupported");
    expect(page.close).toHaveBeenCalledOnce();
    dom.window.close();
  });

  it("records audio and video the browser loads, ignoring other responses", async () => {
    const { page, dom, respond } = fixture();
    page.goto.mockImplementation(async () => {
      respond("https://cdn.example.com/track?id=1", "audio/mpeg");
      respond("https://cdn.example.com/clip", "video/mp4", "fetch");
      respond("https://example.com/app.js", "text/javascript", "script");
      respond("https://cdn.example.com/track?id=1", "audio/mpeg");
      return { status: () => 200, headers: () => ({}) };
    });
    const data = await new CdpEngine("http://localhost:9222").scrape({
      url: "https://example.com/",
      formats: ["markdown"],
    });
    expect(data["mediaRequests"]).toEqual([
      { url: "https://cdn.example.com/track?id=1", contentType: "audio/mpeg" },
      { url: "https://cdn.example.com/clip", contentType: "video/mp4" },
    ]);
    expect(page.getByRole).not.toHaveBeenCalled();
    dom.window.close();
  });

  it("clicks a play control when asked, waits for its media, then pauses playback", async () => {
    const { page, dom, controls, playButton, respond } = fixture();
    dom.window.document.body.insertAdjacentHTML("beforeend", "<audio></audio>");
    const audio = dom.window.document.querySelector("audio")!;
    const pause = vi.fn();
    audio.pause = pause;
    controls.count.mockResolvedValue(1);
    playButton.click.mockImplementation(async () => {
      setTimeout(() => respond("https://cdn.example.com/listening.mp3", "audio/mpeg"), 20);
    });
    const data = await new CdpEngine("http://localhost:9222", {
      playMedia: true,
      mediaSettleMs: 10,
    }).scrape({ url: "https://example.com/", formats: ["markdown"] });
    expect(playButton.click).toHaveBeenCalledOnce();
    expect(page.getByRole).toHaveBeenCalledWith("button", { name: expect.any(RegExp) });
    expect(data["mediaRequests"]).toEqual([
      { url: "https://cdn.example.com/listening.mp3", contentType: "audio/mpeg" },
    ]);
    expect(pause).toHaveBeenCalledOnce();
    expect(data["warning"]).toBeUndefined();
    expect(data.metadata?.["captureReady"]).toBe(true);
    dom.window.close();
  });

  it("keeps the page and warns when no play control or media appears", async () => {
    const missing = fixture();
    const none = await new CdpEngine("http://localhost:9222", { playMedia: true }).scrape({
      url: "https://example.com/",
      formats: ["markdown"],
    });
    expect(none.markdown).toContain("Hello");
    expect(none["warning"]).toMatch(/no visible play control/);
    expect(none.metadata?.["captureReady"]).toBe(true);
    missing.dom.window.close();

    const silent = fixture();
    silent.controls.count.mockResolvedValue(1);
    const quiet = await new CdpEngine("http://localhost:9222", {
      playMedia: true,
      mediaWaitMs: 20,
    }).scrape({ url: "https://example.com/", formats: ["markdown"] });
    expect(silent.playButton.click).toHaveBeenCalledOnce();
    expect(quiet["warning"]).toMatch(/no audio or video was requested/);
    silent.dom.window.close();
  });

  it("reports unavailable Chrome with launch instructions", async () => {
    connect.mockRejectedValue(new Error("connection refused"));
    await expect(new CdpEngine("http://localhost:9222").prepare()).rejects.toThrow(
      /Launch Chrome first/,
    );
  });
});
