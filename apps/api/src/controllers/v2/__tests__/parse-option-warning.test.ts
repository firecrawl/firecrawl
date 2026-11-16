import { getParseOptionWarning } from "../parse";
import { parseRequestSchema, type UploadedParseFileKind } from "../types";

const body = (kind: UploadedParseFileKind, formats: unknown[]) =>
  parseRequestSchema.parse({
    formats,
    file: {
      buffer: Buffer.from("upload"),
      filename: `upload.${kind}`,
      kind,
    },
  });

describe("getParseOptionWarning", () => {
  it("warns when images is requested for a PDF upload", () => {
    for (const formats of [["markdown", "images"], [{ type: "images" }]]) {
      const warning = getParseOptionWarning(body("pdf", formats));
      expect(warning).toContain("does not extract images from PDF files");
      expect(warning).toContain('"blocks": true');
    }
  });

  it("does not warn for a PDF upload without images", () => {
    expect(getParseOptionWarning(body("pdf", ["markdown"]))).toBeNull();
  });

  it("does not warn for images on an HTML upload", () => {
    expect(getParseOptionWarning(body("html", ["images"]))).toBeNull();
  });
});
