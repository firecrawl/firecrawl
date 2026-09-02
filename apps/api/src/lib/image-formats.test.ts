import { describe, expect, it } from "vitest";
import {
  imageContentTypeFromExtension,
  imageExtensionFromContentType,
  imageExtensionFromUrlPath,
  sniffImageContentType,
  sniffImageContentTypeFromBase64,
} from "./image-formats";

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
    expect(imageContentTypeFromExtension(".webp")).toBeNull();
  });

  it("detects image extensions only at the end of a URL path", () => {
    expect(imageExtensionFromUrlPath("/images/gallery/photo.jpg")).toBe(".jpg");
    expect(imageExtensionFromUrlPath("/assets/scan.png")).toBe(".png");
    expect(imageExtensionFromUrlPath("/scan.TIFF")).toBe(".tiff");
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
    expect(
      sniffImageContentTypeFromBase64(Buffer.from("<html>").toString("base64")),
    ).toBeNull();
    expect(sniffImageContentTypeFromBase64("")).toBeNull();
  });
});
