import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { crawl, Identity, idmux, scrapeTimeout } from "./lib";

const resultUrl = (page: { metadata: { url?: string; sourceURL?: string } }) =>
  page.metadata.url ?? page.metadata.sourceURL!;

describeIf(ALLOW_TEST_SUITE_WEBSITE)("Section-anchor crawl discovery", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "crawl-section-anchors",
      concurrency: 10,
      credits: 100,
    });
  }, 10000);

  it(
    "crawls a page linked only through multiple section anchors once",
    async () => {
      const rootPath = "/crawl/section-anchor-only";
      const detailPath = `${rootPath}/detail`;
      const result = await crawl(
        {
          url: `${TEST_SUITE_WEBSITE}${rootPath}`,
          sitemap: "skip",
          limit: 10,
        },
        identity,
      );

      const urls = result.data.map(resultUrl).map(value => new URL(value));
      const paths = urls.map(url => url.pathname.replace(/\/$/, ""));

      expect(result.completed).toBe(2);
      expect(paths).toEqual(expect.arrayContaining([rootPath, detailPath]));
      expect(paths.filter(path => path === detailPath)).toHaveLength(1);
      expect(urls.every(url => url.hash === "")).toBe(true);
    },
    2 * scrapeTimeout,
  );

  it(
    "does not re-enqueue an already-crawled page from a later section link",
    async () => {
      const rootPath = "/crawl/section-anchor-dedupe";
      const detailPath = `${rootPath}/detail`;
      const laterPath = `${rootPath}/later`;
      const result = await crawl(
        {
          url: `${TEST_SUITE_WEBSITE}${rootPath}`,
          sitemap: "skip",
          ignoreQueryParameters: true,
          limit: 10,
        },
        identity,
      );

      const urls = result.data.map(resultUrl).map(value => new URL(value));
      const paths = urls.map(url => url.pathname.replace(/\/$/, ""));

      expect(result.completed).toBe(3);
      expect(paths).toEqual(
        expect.arrayContaining([rootPath, detailPath, laterPath]),
      );
      expect(paths.filter(path => path === detailPath)).toHaveLength(1);
      expect(urls.every(url => url.hash === "")).toBe(true);
    },
    3 * scrapeTimeout,
  );
});
