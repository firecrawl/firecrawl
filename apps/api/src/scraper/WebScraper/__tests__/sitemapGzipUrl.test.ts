import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "winston";

const fixture = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return {
    logger,
    xml: '<?xml version="1.0"?><urlset><url><loc>https://example.com/page</loc></url></urlset>',
  };
});

vi.mock("../../../lib/logger", () => ({ logger: fixture.logger }));
vi.mock("../../../controllers/v2/types", () => ({
  scrapeOptions: { parse: (value: unknown) => value },
}));
vi.mock("../../../lib/cost-tracking", () => ({ CostTracking: class {} }));
vi.mock("../../../services", () => ({ useIndex: false }));
vi.mock("../../scrapeURL/engines/fire-engine/available", () => ({
  useFireEngine: false,
}));
vi.mock("../crawler", () => ({
  SITEMAP_LIMIT: 100,
  WebCrawler: class {
    isFile() {
      return false;
    }
  },
}));
vi.mock("../../scrapeURL", () => ({ scrapeURL: vi.fn() }));
vi.mock("../../scrapeURL/engines/utils/downloadFile", () => ({
  fetchFileToBuffer: vi.fn(),
}));
vi.mock("@mendable/firecrawl-rs", () => ({
  processSitemap: vi.fn(async (xml: string) => {
    if (xml !== fixture.xml) throw new Error("XML parsing error");
    return {
      instructions: [{ action: "process", urls: ["https://example.com/page"] }],
    };
  }),
  parseSitemapXml: vi.fn(async () => {
    throw new Error("XML parsing error");
  }),
}));

import { scrapeURL } from "../../scrapeURL";
import { fetchFileToBuffer } from "../../scrapeURL/engines/utils/downloadFile";
import { MAX_GUNZIPPED_FILE_SIZE } from "../../scrapeURL/engines/utils/gunzip";
import { getLinksFromSitemap } from "../sitemap";
import { scrapeSitemap } from "../../crawler/sitemap";

const compressedUrls = [
  "https://example.com/sitemap.xml.gz",
  "https://example.com/sitemap.xml.gz?token=fixture&download=1",
  "https://example.com/sitemap.xml.gz#part",
  "https://example.com/SITEMAP.XML.GZ?token=fixture",
];
const plainUrls = [
  "https://example.com/sitemap.xml",
  "https://example.com/sitemap.xml?filename=sitemap.xml.gz",
  "https://example.com/sitemap.xml#archive.gz",
  "https://sitemap.gz",
];

beforeEach(() => {
  vi.clearAllMocks();
  const bytes = (url: string) =>
    compressedUrls.includes(url)
      ? gzipSync(fixture.xml)
      : Buffer.from(fixture.xml);
  vi.mocked(fetchFileToBuffer).mockImplementation(
    async url =>
      ({
        buffer: bytes(url),
      }) as any,
  );
  vi.mocked(scrapeURL).mockImplementation(
    async (_id, url) =>
      ({
        success: true,
        document: {
          rawHtml: bytes(url).toString("utf8"),
          metadata: { statusCode: 200 },
        },
      }) as any,
  );
});

describe.each(["legacy", "crawler"] as const)(
  "%s sitemap gzip URL routing",
  kind => {
    const headers = { "X-Sitemap-Token": "fixture" };
    const signal = new AbortController().signal;
    const read = async (url: string) => {
      if (kind === "crawler") {
        const result = await scrapeSitemap({
          url,
          maxAge: 0,
          zeroDataRetention: false,
          location: undefined,
          crawlId: "crawl-fixture",
        });
        return result.urls.map(item => item.href);
      }
      const urls: string[] = [];
      await getLinksFromSitemap(
        {
          sitemapUrl: url,
          urlsHandler: values => urls.push(...values),
          zeroDataRetention: false,
          headers,
        },
        fixture.logger as unknown as Logger,
        "crawl-fixture",
        new Set(),
        signal,
      );
      return urls;
    };

    it.each(compressedUrls)("decompresses the gzip file at %s", async url => {
      expect(await read(url)).toEqual(["https://example.com/page"]);
      expect(fetchFileToBuffer).toHaveBeenCalledExactlyOnceWith(
        url,
        false,
        kind === "legacy" ? { headers, signal } : undefined,
        MAX_GUNZIPPED_FILE_SIZE,
      );
      expect(scrapeURL).not.toHaveBeenCalled();
    });

    it.each(plainUrls)(
      "keeps non-gzip paths on the ordinary fetch path: %s",
      async url => {
        expect(await read(url)).toEqual(["https://example.com/page"]);
        expect(fetchFileToBuffer).not.toHaveBeenCalled();
        expect(scrapeURL).toHaveBeenCalledOnce();
        expect(vi.mocked(scrapeURL).mock.calls[0][1]).toBe(url);
      },
    );

    it("still rejects damaged gzip bytes", async () => {
      vi.mocked(fetchFileToBuffer).mockResolvedValue({
        buffer: Buffer.from("damaged"),
      } as any);
      const result = read(compressedUrls[1]);
      if (kind === "crawler") {
        await expect(result).rejects.toThrow("could not be decompressed");
      } else {
        expect(await result).toEqual([]);
      }
      expect(fetchFileToBuffer).toHaveBeenCalledOnce();
    });
  },
);

describe("legacy sitemap URL diagnostics", () => {
  it.each(["/sitemap.xml.gz", "not a URL", "https://[bad-host/sitemap.xml.gz"])(
    "logs an invalid URL at error level before fetching: %s",
    async sitemapUrl => {
      const result = await getLinksFromSitemap(
        {
          sitemapUrl,
          urlsHandler: vi.fn(),
          zeroDataRetention: false,
        },
        fixture.logger as unknown as Logger,
        "crawl-fixture",
        new Set(),
      );
      expect(result).toBe(0);
      expect(fixture.logger.error).toHaveBeenCalledWith(
        "Invalid sitemap URL",
        expect.objectContaining({ sitemapUrl, error: expect.any(TypeError) }),
      );
      expect(fixture.logger.debug).not.toHaveBeenCalled();
      expect(fetchFileToBuffer).not.toHaveBeenCalled();
      expect(scrapeURL).not.toHaveBeenCalled();
    },
  );
});
