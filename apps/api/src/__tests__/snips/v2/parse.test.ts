import path from "path";
import fs from "fs";
import request, { idmux, scrapeTimeout, TEST_API_URL, Identity } from "./lib";

describe("Parse tests", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "parse",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  const samplesDir = path.join(process.cwd(), "samples");
  const fixturesDir = path.join(
    process.cwd(),
    "src/__tests__/snips/v2/fixtures",
  );

  it.concurrent(
    "parses a docx upload to markdown",
    async () => {
      const docxPath = path.join(samplesDir, "sample.docx");
      expect(fs.existsSync(docxPath)).toBe(true);

      const response = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .field("options", JSON.stringify({ formats: ["markdown"] }))
        .attach("file", docxPath);

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data?.markdown).toBeTruthy();
      expect(response.body.data?.metadata?.statusCode).toBe(200);
      expect(response.body.data?.metadata?.contentType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(response.body.data?.metadata?.url).toMatch(/^file:\/\/local\//);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "parses a markdown upload to html and markdown",
    async () => {
      const mdPath = path.join(fixturesDir, "sample.md");
      expect(fs.existsSync(mdPath)).toBe(true);

      const response = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .field("options", JSON.stringify({ formats: ["html", "markdown"] }))
        .attach("file", mdPath);

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data?.html).toBeTruthy();
      expect(response.body.data?.markdown).toBeTruthy();
      expect(response.body.data?.metadata?.contentType).toBe("text/markdown");
      expect(response.body.data?.metadata?.url).toMatch(/^file:\/\/local\//);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects unsupported file types",
    async () => {
      const zipPath = path.join(fixturesDir, "sample.zip");
      expect(fs.existsSync(zipPath)).toBe(true);

      const response = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .attach("file", zipPath);

      expect(response.statusCode).toBe(415);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("SCRAPE_UNSUPPORTED_FILE_ERROR");
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects files over the size limit",
    async () => {
      const tooLarge = Buffer.alloc(20 * 1024 * 1024 + 1, "a");

      const response = await request(TEST_API_URL)
        .post("/v2/parse")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .attach("file", tooLarge, "big.txt");

      expect(response.statusCode).toBe(413);
      expect(response.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
