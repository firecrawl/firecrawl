import { describe, expect, it } from "vitest";
import {
  imageContentTypeFromExtension,
  imageExtensionFromContentType,
  imageExtensionFromUrlPath,
  sniffImageContentType,
  sniffImageContentTypeFromBase64,
} from "./image-formats";

// The 12-byte JP2 signature box: length, "jP  ", then the CR LF 0x87 LF check.
const JP2_SIGNATURE = [
  0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
];

describe("image-formats", () => {
  it("maps content types to extensions, ignoring parameters and case", () => {
    expect(imageExtensionFromContentType("image/png")).toBe(".png");
    expect(imageExtensionFromContentType("image/png;charset=UTF-8")).toBe(
      ".png",
    );
    expect(imageExtensionFromContentType("Image/JPEG")).toBe(".jpg");
    expect(imageExtensionFromContentType("image/jpg")).toBe(".jpg");
    expect(imageExtensionFromContentType("image/pjpeg")).toBe(".jpg");
    expect(imageExtensionFromContentType("image/x-tiff")).toBe(".tif");
    expect(imageExtensionFromContentType("image/tiff")).toBe(".tif");
    expect(imageExtensionFromContentType("image/jp2")).toBe(".jp2");
    expect(imageExtensionFromContentType("image/jpx")).toBe(".jp2");
    expect(imageExtensionFromContentType("image/j2k")).toBe(".jp2");
    expect(imageExtensionFromContentType("image/j2c")).toBe(".jp2");
    expect(imageExtensionFromContentType("image/x-j2c")).toBe(".jp2");
    expect(imageExtensionFromContentType("image/webp")).toBeNull();
    expect(imageExtensionFromContentType("image/svg+xml")).toBeNull();
    expect(imageExtensionFromContentType(undefined)).toBeNull();
  });

  it("maps extensions and their aliases back to content types", () => {
    expect(imageContentTypeFromExtension(".jpg")).toBe("image/jpeg");
    expect(imageContentTypeFromExtension(".JPEG")).toBe("image/jpeg");
    expect(imageContentTypeFromExtension(".tiff")).toBe("image/tiff");
    expect(imageContentTypeFromExtension(".tif")).toBe("image/tiff");
    expect(imageContentTypeFromExtension(".png")).toBe("image/png");
    expect(imageContentTypeFromExtension(".jp2")).toBe("image/jp2");
    expect(imageContentTypeFromExtension(".JPX")).toBe("image/jp2");
    expect(imageContentTypeFromExtension(".jpf")).toBe("image/jp2");
    expect(imageContentTypeFromExtension(".j2k")).toBe("image/jp2");
    expect(imageContentTypeFromExtension(".j2c")).toBe("image/jp2");
    expect(imageContentTypeFromExtension(".webp")).toBeNull();
  });

  it("detects image extensions only at the end of a URL path", () => {
    expect(imageExtensionFromUrlPath("/images/gallery/photo.jpg")).toBe(".jpg");
    expect(imageExtensionFromUrlPath("/assets/scan.png")).toBe(".png");
    expect(imageExtensionFromUrlPath("/scan.TIFF")).toBe(".tiff");
    expect(imageExtensionFromUrlPath("/scans/page-0001.jp2")).toBe(".jp2");
    expect(imageExtensionFromUrlPath("/tiles/region.j2k")).toBe(".j2k");
    expect(imageExtensionFromUrlPath("/tiles/region.j2c")).toBe(".j2c");
    expect(imageExtensionFromUrlPath("/photos/frame.jpf")).toBe(".jpf");
    expect(imageExtensionFromUrlPath("/img.png/viewer")).toBeNull();
    expect(imageExtensionFromUrlPath("/photo.webp")).toBeNull();
    expect(imageExtensionFromUrlPath("/paper.pdf")).toBeNull();
  });

  it("sniffs supported formats from magic bytes", () => {
    expect(
      sniffImageContentType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(sniffImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(sniffImageContentType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageContentType(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe(
      "image/tiff",
    );
    expect(sniffImageContentType(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe(
      "image/tiff",
    );
    expect(sniffImageContentType(Buffer.from("BM\x36\x00"))).toBe("image/bmp");
  });

  it("sniffs JPEG 2000 containers and raw codestreams", () => {
    // Signature box followed by the file-type box header, as real encoders
    // write it.
    const jp2 = Buffer.concat([
      Buffer.from(JP2_SIGNATURE),
      Buffer.from("\x00\x00\x00\x14ftyp", "latin1"),
    ]);
    expect(sniffImageContentType(jp2)).toBe("image/jp2");
    // Raw codestream: SOC marker then SIZ marker.
    expect(
      sniffImageContentType(Buffer.from([0xff, 0x4f, 0xff, 0x51, 0x00, 0x2f])),
    ).toBe("image/jp2");
    // The box length and type alone are not the full signature.
    expect(
      sniffImageContentType(Buffer.from(JP2_SIGNATURE.slice(0, 8))),
    ).toBeNull();
  });

  it("rejects non-image and truncated payloads", () => {
    expect(sniffImageContentType(Buffer.from("<!DOCTYPE html>"))).toBeNull();
    expect(sniffImageContentType(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(
      sniffImageContentType(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ")),
    ).toBeNull();
    expect(sniffImageContentType(Buffer.from([0x89, 0x50]))).toBeNull();
    // Only the first six PNG bytes: not a file mupdf-style loaders accept.
    expect(
      sniffImageContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
    ).toBeNull();
    expect(sniffImageContentType(Buffer.alloc(0))).toBeNull();
  });

  it("sniffs a base64 payload from its prefix alone", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]).toString("base64");
    expect(sniffImageContentTypeFromBase64(png)).toBe("image/png");
    // The JP2 signature is the longest one; the prefix window must cover it.
    const jp2 = Buffer.concat([
      Buffer.from(JP2_SIGNATURE),
      Buffer.alloc(64, 1),
    ]).toString("base64");
    expect(sniffImageContentTypeFromBase64(jp2)).toBe("image/jp2");
    expect(
      sniffImageContentTypeFromBase64(Buffer.from("<html>").toString("base64")),
    ).toBeNull();
    expect(sniffImageContentTypeFromBase64("")).toBeNull();
  });
});
