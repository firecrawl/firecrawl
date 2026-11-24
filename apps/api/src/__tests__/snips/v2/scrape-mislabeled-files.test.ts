import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  itIf,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { config } from "../../../config";
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

// Mirrors the API's image OCR switch (the harness shares its environment
// with the server under test).
const IMAGE_OCR_ON = !!config.FIRE_PDF_BASE_URL && config.IMAGE_OCR_ENABLED;

// The browser engine hands files it cannot render back to the API, which
// routes them to a parser by content type — and servers mislabel. Static
// hosts serve a `.jp2` file as image/jp2 whatever its bytes are, so
// mislabeled-pdf.jp2 reproduces a PDF served with an image content type,
// while tiny-image.jp2 is a real JPEG 2000 image, which follows the image
// OCR switch: rejected while it is off, an empty document (it is 16 px and
// has no text) while it is on. The OCR behaviour itself lives in
// scrape-image-ocr.test.ts. Only fire-engine performs the handoff, hence
// the gate.
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

    itIf(!IMAGE_OCR_ON)(
      "keeps rejecting a real JPEG 2000 image while image OCR is off",
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

    itIf(IMAGE_OCR_ON)(
      "OCRs a real JPEG 2000 image while image OCR is on",
      async () => {
        const response = await scrape(
          {
            url: `${TEST_SUITE_WEBSITE}/tiny-image.jp2`,
            formats: ["markdown"],
          },
          identity,
        );

        expect(response.metadata.contentType).toBe("image/jp2");
        expect(response.metadata.statusCode).toBe(200);
        expect(response.markdown).toBe("");
      },
      scrapeTimeout,
    );
  },
);

describeIf(ALLOW_TEST_SUITE_WEBSITE)("PDF URL serving HTML", () => {
  it(
    "scrapes the HTML viewer page served at a .pdf URL",
    async () => {
      const response = await scrape(
        {
          url: `${TEST_SUITE_WEBSITE}/embedded-pdf.pdf`,
          formats: ["markdown"],
        },
        identity,
      );

      expect(response.markdown).toContain(
        "Firecrawl embedded PDF viewer fixture",
      );
      expect(response.metadata.title).toBe("Embedded PDF Viewer");
      expect(response.metadata.contentType).toContain("text/html");
      expect(response.metadata.numPages).toBeUndefined();
      expect(response.metadata.statusCode).toBe(200);
    },
    scrapeTimeout,
  );

  it(
    "reports a missing .pdf URL as a 404 instead of a PDF error",
    async () => {
      const response = await scrape(
        {
          url: `${TEST_SUITE_WEBSITE}/missing.pdf`,
          formats: ["markdown"],
        },
        identity,
      );

      expect(response.metadata.statusCode).toBe(404);
      expect(response.metadata.numPages).toBeUndefined();
    },
    scrapeTimeout,
  );

  itIf(TEST_SELF_HOST)(
    "fails a corrupt PDF without falling back to the HTML engines",
    async () => {
      const response = await scrapeWithFailure(
        {
          url: `${TEST_SUITE_WEBSITE}/corrupt.pdf`,
          formats: ["markdown"],
        },
        identity,
      );

      expect(response.error).toContain("All scraping engines failed");
      expect(response.error).toContain("Engines tried: [pdf]");
    },
    scrapeTimeout,
  );
});
