import { scrapeSitemap } from "../sitemap";
import { scrapeURL } from "../../scrapeURL";
import { processSitemap } from "@mendable/firecrawl-rs";

vi.mock("../../scrapeURL", () => ({ scrapeURL: vi.fn() }));
vi.mock("../../../controllers/v2/types", () => ({
  scrapeOptions: { parse: (x: unknown) => x },
}));
vi.mock("../../../lib/cost-tracking", () => ({ CostTracking: class {} }));
vi.mock("../../../lib/error", () => ({ SitemapError: class extends Error {} }));
vi.mock("../../scrapeURL/engines/fire-engine/available", () => ({
  useFireEngine: false,
}));
vi.mock("../../scrapeURL/engines/utils/downloadFile", () => ({
  fetchFileToBuffer: vi.fn(),
}));
vi.mock("../../../services", () => ({ useIndex: false }));
vi.mock("@mendable/firecrawl-rs", () => ({ processSitemap: vi.fn() }));
vi.mock("../../../lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn() }) },
}));

const options = {
  url: "https://example.com/sitemap.xml",
  crawlId: "test",
  maxAge: 0,
  zeroDataRetention: false,
  location: undefined,
};
const response = {
  success: true,
  document: { rawHtml: "<urlset/>", metadata: { statusCode: 200 } },
} as any;
beforeEach(() => vi.resetAllMocks());

it("bounds concurrent crawl sitemap downloads and parsing", async () => {
  let active = 0;
  let peak = 0;
  vi.mocked(scrapeURL).mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => setImmediate(resolve));
    return response;
  });
  vi.mocked(processSitemap).mockImplementation(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return {
      instructions: [
        { action: "process", urls: ["https://example.com/page"], count: 1 },
      ],
      totalCount: 1,
    };
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => scrapeSitemap(options)),
  );
  expect(
    results.every(result => result.urls[0].href === "https://example.com/page"),
  ).toBe(true);
  expect(peak).toBeLessThanOrEqual(3);
  expect(active).toBe(0);
});

it("releases permits after malformed XML and preserves the sitemap error", async () => {
  vi.mocked(scrapeURL).mockResolvedValue(response);
  vi.mocked(processSitemap).mockRejectedValue(
    new Error("XML parsing error: malformed"),
  );
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => scrapeSitemap(options)),
  );
  expect(
    results.every(
      result =>
        result.status === "rejected" &&
        result.reason.message.includes("could not be parsed"),
    ),
  ).toBe(true);
  vi.mocked(processSitemap).mockResolvedValue({
    instructions: [],
    totalCount: 0,
  });
  expect(await scrapeSitemap(options)).toEqual({ urls: [], sitemaps: [] });
});
