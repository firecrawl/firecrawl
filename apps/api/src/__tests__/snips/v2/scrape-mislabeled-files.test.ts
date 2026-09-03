import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  idmux,
  Identity,
  scrape,
  scrapeTimeout,
  scrapeWithFailure,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-mislabeled-files",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// The browser engine hands files it cannot render back to the API, which
// routes them to a parser by content type — and servers mislabel. Static
// hosts serve a `.jp2` file as image/jp2 whatever its bytes are, so
// mislabeled-pdf.jp2 reproduces a PDF served with an image content type,
// while tiny-image.jp2 is a real JPEG 2000 image. This identity has no
// imageOcr team flag, so the real image must keep the historical rejection
// (the flagged behaviour lives in scrape-image-ocr.test.ts). Only
// fire-engine performs the handoff, hence the gate.
describeIf(!process.env.TEST_SUITE_SELF_HOSTED && ALLOW_TEST_SUITE_WEBSITE)(
  "Mislabeled file handoff (f-e dependent)",
  () => {
    it(
      "parses a PDF served with an image content type",
      async () => {
        const response = await scrape(
          {
            url: `${TEST_SUITE_WEBSITE}/mislabeled-pdf.jp2`,
            formats: ["markdown"],
          },
          identity,
        );

        expect(response.markdown).toContain("Firecrawl mislabeled PDF fixture");
        expect(response.metadata.contentType).toBe("application/pdf");
        expect(response.metadata.numPages).toBe(1);
        expect(response.metadata.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    it(
      "keeps rejecting a real JPEG 2000 image for a team without image OCR",
      async () => {
        const response = await scrapeWithFailure(
          {
            url: `${TEST_SUITE_WEBSITE}/tiny-image.jp2`,
            formats: ["markdown"],
          },
          identity,
        );

        expect(response.error).toContain("cannot process");
        expect(response.error).toContain("image/jp2");
      },
      scrapeTimeout,
    );
  },
);
