import request from "supertest";
import { z } from "zod";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_API_URL,
  TEST_SUITE_WEBSITE,
} from "../lib";
import type { Identity } from "./lib";
import { idmux, scrape, scrapeTimeout, scrapeWithFailure } from "./lib";

const parseFormatsResponseSchema = z.object({
  data: z.object({
    formats: z.array(
      z.object({
        kind: z.string().optional(),
        available: z.boolean().optional(),
      }),
    ),
  }),
});

let identity: Identity;
let imageOcrOn = false;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-mislabeled-files",
    concurrency: 100,
    credits: 1_000_000,
  });

  const formatsResponse = await request(TEST_API_URL)
    .get("/v2/parse/formats")
    .set("Authorization", `Bearer ${identity.apiKey}`);
  if (formatsResponse.statusCode === 200) {
    const parsedFormats = parseFormatsResponseSchema.safeParse(
      formatsResponse.body,
    );
    if (parsedFormats.success) {
      imageOcrOn = parsedFormats.data.data.formats.some(
        format => format.kind === "image" && format.available === true,
      );
    }
  }
}, 10_000 + scrapeTimeout);

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

    it(
      "handles a real JPEG 2000 image according to active image OCR capability",
      async () => {
        if (!imageOcrOn) {
          const response = await scrapeWithFailure(
            {
              url: `${TEST_SUITE_WEBSITE}/tiny-image.jp2`,
              formats: ["markdown"],
            },
            identity,
          );

          expect(response.error).toContain("cannot process");
          expect(response.error).toContain("image/jp2");
          return;
        }

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
