import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { config } from "../../../config";
import { idmux, Identity, scrape, scrapeTimeout } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "parsers-pdf-page-markdown",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

const SHOULD_RUN = ALLOW_TEST_SUITE_WEBSITE && !!config.FIRE_PDF_BASE_URL;

describeIf(SHOULD_RUN)("PDF physical page markdown", () => {
  it(
    "returns additive pages without changing document markdown",
    async () => {
      const response = await scrape(
        {
          url: `${TEST_SUITE_WEBSITE}/example.pdf`,
          formats: ["markdown"],
          parsers: [{ type: "pdf", mode: "auto", pageMarkdown: true }],
        },
        identity,
      );

      expect(response.markdown).toContain("PDF Test File");
      expect(response.pages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pageNumber: 1,
            markdown: expect.any(String),
          }),
        ]),
      );
      expect(response.pages).toHaveLength(response.metadata.numPages!);
    },
    scrapeTimeout * 3,
  );
});
