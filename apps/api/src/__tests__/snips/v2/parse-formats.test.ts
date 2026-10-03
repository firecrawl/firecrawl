import { describeIf, TEST_PRODUCTION } from "../lib";
import request, { idmux, Identity, scrapeTimeout, TEST_API_URL } from "./lib";

type ParseFormat = {
  format: string;
  kind: "document" | "image";
  extensions: string[];
  mimeTypes: string[];
  available: boolean;
};

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "parse-formats",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

async function getParseFormats(): Promise<ParseFormat[]> {
  const response = await request(TEST_API_URL)
    .get("/v2/parse/formats")
    .set("Authorization", `Bearer ${identity.apiKey}`);

  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  expect(response.body.success).toBe(true);
  expect(response.headers["cache-control"]).toBe("private, max-age=3600");
  return response.body.data.formats;
}

// screenshot output is rejected after the upload type is accepted, so a
// PARSE_UNSUPPORTED_OPTIONS answer proves the type passed validation without
// running a parse.
async function parseValidationCode(filename: string, contentType: string) {
  const response = await request(TEST_API_URL)
    .post("/v2/parse")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .attach("file", Buffer.from("format-probe"), { filename, contentType })
    .field("options", JSON.stringify({ formats: ["screenshot"] }));

  expect(response.statusCode, JSON.stringify(response.body)).toBe(400);
  return response.body.code as string;
}

describe("GET /v2/parse/formats", () => {
  it(
    "lists known document and image formats",
    async () => {
      const formats = await getParseFormats();
      const byName = new Map(formats.map(format => [format.format, format]));

      expect(byName.get("pdf")).toMatchObject({
        kind: "document",
        available: true,
        extensions: [".pdf"],
        mimeTypes: ["application/pdf"],
      });
      expect(byName.get("docx")).toMatchObject({
        kind: "document",
        available: true,
        extensions: [".docx"],
        mimeTypes: [
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
      });
      expect(byName.get("png")).toMatchObject({
        kind: "image",
        extensions: [".png"],
        mimeTypes: ["image/png"],
      });
      expect(byName.get("jpg")?.extensions).toEqual(
        expect.arrayContaining([".jpg", ".jpeg"]),
      );

      for (const format of formats) {
        expect(format.extensions.length).toBeGreaterThan(0);
        expect(format.mimeTypes.length).toBeGreaterThan(0);
        expect(typeof format.available).toBe("boolean");
        if (format.kind === "document") expect(format.available).toBe(true);
      }
    },
    scrapeTimeout,
  );

  it(
    "matches what /v2/parse accepts for every listed extension and MIME type",
    async () => {
      const formats = await getParseFormats();
      const probes = formats.flatMap(format => [
        ...format.extensions.map(extension => ({
          format,
          filename: `probe${extension}`,
          contentType: "application/octet-stream",
        })),
        ...format.mimeTypes.map(mimeType => ({
          format,
          filename: "probe",
          contentType: mimeType,
        })),
      ]);

      for (const probe of probes) {
        const code = await parseValidationCode(
          probe.filename,
          probe.contentType,
        );
        expect({ ...probe, code }).toEqual({
          ...probe,
          code: probe.format.available
            ? "PARSE_UNSUPPORTED_OPTIONS"
            : "UNSUPPORTED_FILE_TYPE",
        });
      }
    },
    scrapeTimeout * 2,
  );

  it(
    "rejects the wrong method",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/parse/formats")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send({});

      expect(response.statusCode).toBe(405);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("METHOD_NOT_ALLOWED");
      expect(response.body.allowed_methods).toContain("GET");
    },
    scrapeTimeout,
  );

  describeIf(TEST_PRODUCTION)("auth", () => {
    it(
      "rejects an invalid API key",
      async () => {
        const response = await request(TEST_API_URL)
          .get("/v2/parse/formats")
          .set("Authorization", "Bearer fc-invalid-api-key");

        expect(response.statusCode).toBe(401);
        expect(response.body.success).toBe(false);
      },
      scrapeTimeout,
    );
  });
});
