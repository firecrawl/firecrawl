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
  const page = {
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
  return { page, cookies, context, browser, dom };
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

  it("reports unavailable Chrome with launch instructions", async () => {
    connect.mockRejectedValue(new Error("connection refused"));
    await expect(new CdpEngine("http://localhost:9222").prepare()).rejects.toThrow(
      /Launch Chrome first/,
    );
  });
});
