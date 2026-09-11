import { getLinksFromSitemap } from "../sitemap";
import { scrapeURL } from "../../scrapeURL";
import { processSitemap, parseSitemapXml } from "@mendable/firecrawl-rs";

vi.mock("../crawler", () => ({
  SITEMAP_LIMIT: 25,
  WebCrawler: class {
    isFile() {
      return false;
    }
  },
}));
vi.mock("../../scrapeURL", () => ({ scrapeURL: vi.fn() }));
vi.mock("../../../controllers/v2/types", () => ({
  scrapeOptions: { parse: (x: unknown) => x },
}));
vi.mock("../../../lib/cost-tracking", () => ({ CostTracking: class {} }));
vi.mock("../../../lib/error", () => ({
  ScrapeJobTimeoutError: class extends Error {},
}));
vi.mock("../../scrapeURL/engines/fire-engine/available", () => ({
  useFireEngine: false,
}));
vi.mock("../../scrapeURL/engines/utils/downloadFile", () => ({
  fetchFileToBuffer: vi.fn(),
}));
vi.mock("../../../services", () => ({ useIndex: false }));
vi.mock("@mendable/firecrawl-rs", () => ({
  processSitemap: vi.fn(),
  parseSitemapXml: vi.fn(),
}));

const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const result = (action: string, urls: string[]) => ({
  instructions: [{ action, urls, count: urls.length }],
  totalCount: urls.length,
});
const response = (body: string) =>
  ({
    success: true,
    document: { rawHtml: body, metadata: { statusCode: 200 } },
  }) as any;
const run = (
  url: string,
  handler: (urls: string[]) => unknown,
  signal?: AbortSignal,
) =>
  getLinksFromSitemap(
    { sitemapUrl: url, urlsHandler: handler, zeroDataRetention: false },
    logger,
    url,
    new Set(),
    signal,
  );

beforeEach(() => vi.resetAllMocks());

it("bounds fetching and parsing across simultaneous nested sitemap traversals", async () => {
  let active = 0;
  let peak = 0;
  vi.mocked(scrapeURL).mockImplementation(async (_, url) => {
    peak = Math.max(peak, ++active);
    await tick();
    return response(url);
  });
  vi.mocked(processSitemap).mockImplementation(async url => {
    await tick();
    active--;
    return url.endsWith("root.xml")
      ? result(
          "recurse",
          Array.from({ length: 10 }, (_, i) =>
            url.replace("root.xml", `${i}.xml`),
          ),
        )
      : result("process", [url.replace(".xml", "/page")]);
  });
  const urls: string[] = [];
  await Promise.all(
    ["a", "b"].map(host =>
      run(`https://${host}.example/root.xml`, xs => urls.push(...xs)),
    ),
  );
  expect(urls).toHaveLength(20);
  expect(new Set(urls).size).toBe(20);
  expect(peak).toBeLessThanOrEqual(3);
  expect(active).toBe(0);
});

it("releases capacity after a failed child and returns healthy siblings", async () => {
  vi.mocked(scrapeURL).mockImplementation(async (_, url) => {
    if (url.endsWith("bad.xml")) throw new Error("upstream failed");
    return response(url);
  });
  vi.mocked(processSitemap).mockImplementation(async url =>
    url.endsWith("root.xml")
      ? result("recurse", [
          "https://example.com/bad.xml",
          "https://example.com/good.xml",
        ])
      : result("process", ["https://example.com/page"]),
  );
  const urls: string[] = [];
  expect(
    await run("https://example.com/root.xml", xs => urls.push(...xs)),
  ).toBe(1);
  expect(urls).toEqual(["https://example.com/page"]);
});

it("cancels queued fetches and does not deliver URLs after abort", async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  vi.mocked(scrapeURL).mockImplementation(async (_, url) => {
    await pending;
    return response(url);
  });
  vi.mocked(processSitemap).mockResolvedValue(
    result("process", ["https://example.com/page"]),
  );
  const handler = vi.fn();
  const requests = Array.from({ length: 10 }, (_, i) =>
    run(`https://example.com/${i}.xml`, handler, controller.signal),
  );
  await tick();
  controller.abort();
  finish();
  await Promise.all(requests);
  expect(scrapeURL).toHaveBeenCalledTimes(3);
  expect(handler).not.toHaveBeenCalled();
  expect(await run("https://example.com/after.xml", handler)).toBe(1);
});

it("handles an empty fallback sitemap index without failing", async () => {
  vi.mocked(scrapeURL).mockResolvedValue(response("<sitemapindex/>"));
  vi.mocked(processSitemap).mockRejectedValue(
    new Error("native parser failed"),
  );
  vi.mocked(parseSitemapXml).mockResolvedValue({
    sitemapindex: { sitemap: [] },
  });
  expect(await run("https://example.com/root.xml", vi.fn())).toBe(0);
  expect(logger.debug).not.toHaveBeenCalledWith(
    expect.stringContaining("Error processing"),
    expect.anything(),
  );
});

it("releases the parent permit before traversing deeply nested indexes", async () => {
  vi.mocked(scrapeURL).mockImplementation(async (_, url) => response(url));
  vi.mocked(processSitemap).mockImplementation(async url => {
    const depth = Number(new URL(url).pathname.slice(1, -4));
    return depth < 8
      ? result("recurse", [`https://example.com/${depth + 1}.xml`])
      : result("process", ["https://example.com/deep-page"]);
  });
  const handler = vi.fn();
  expect(await run("https://example.com/0.xml", handler)).toBe(1);
  expect(handler).toHaveBeenCalledWith(["https://example.com/deep-page"]);
});

it("preserves URL inventory from large XML with alternate-language entries", async () => {
  const native = await vi.importActual<typeof import("@mendable/firecrawl-rs")>(
    "@mendable/firecrawl-rs",
  );
  vi.mocked(processSitemap).mockImplementation(native.processSitemap);
  const xml = `<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml">${Array.from(
    { length: 2000 },
    (_, i) =>
      `<url><loc>https://example.com/page-${i}</loc>${Array.from(
        { length: 20 },
        (_, lang) =>
          `<xhtml:link rel="alternate" hreflang="lang-${lang}" href="https://example.com/${lang}/page-${i}"/>`,
      ).join("")}</url>`,
  ).join("")}</urlset>`;
  vi.mocked(scrapeURL).mockResolvedValue(response(xml));
  const urls: string[] = [];
  expect(
    await run("https://example.com/root.xml", xs => urls.push(...xs)),
  ).toBe(2000);
  expect(urls).toHaveLength(2000);
  expect(urls[0]).toBe("https://example.com/page-0");
  expect(urls.at(-1)).toBe("https://example.com/page-1999");
});
