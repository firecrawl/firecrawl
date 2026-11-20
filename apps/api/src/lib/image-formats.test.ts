import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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

function fileTypeBox(major: string, compatible: string[], extended = false) {
  const header = extended ? 16 : 8;
  const bytes = Buffer.alloc(header + 8 + compatible.length * 4);
  bytes.writeUInt32BE(extended ? 1 : bytes.length, 0);
  bytes.write("ftyp", 4);
  if (extended) bytes.writeBigUInt64BE(BigInt(bytes.length), 8);
  bytes.write(major, header);
  compatible.forEach((brand, index) =>
    bytes.write(brand, header + 8 + index * 4),
  );
  return bytes;
}

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
    expect(imageExtensionFromContentType("image/webp")).toBe(".webp");
    expect(imageExtensionFromContentType("image/avif")).toBe(".avif");
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
    expect(imageContentTypeFromExtension(".webp")).toBe("image/webp");
    expect(imageContentTypeFromExtension(".AVIF")).toBe("image/avif");
    expect(imageContentTypeFromExtension(".svg")).toBeNull();
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
    expect(imageExtensionFromUrlPath("/photo.webp")).toBe(".webp");
    expect(imageExtensionFromUrlPath("/icons/logo.svg")).toBeNull();
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

  it("sniffs WebP and AVIF containers through their length fields", () => {
    // RIFF header, a chunk size that differs per file, then the WEBP tag.
    expect(
      sniffImageContentType(Buffer.from("RIFF\x76\x11\x00\x00WEBPVP8L")),
    ).toBe("image/webp");
    expect(
      sniffImageContentType(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ")),
    ).toBe("image/webp");
    // ftyp box of any size, still-image and image-sequence brands.
    expect(
      sniffImageContentType(Buffer.from("\x00\x00\x00\x20ftypavif\x00\x00")),
    ).toBe("image/avif");
    expect(sniffImageContentType(Buffer.from("\x00\x00\x00\x1cftypavis"))).toBe(
      "image/avif",
    );
    // The tag alone, without its container header, is not a match.
    expect(sniffImageContentType(Buffer.from("WEBPVP8 "))).toBeNull();
    expect(sniffImageContentType(Buffer.from("ftypavif"))).toBeNull();
  });

  it("rejects non-image and truncated payloads", () => {
    expect(sniffImageContentType(Buffer.from("<!DOCTYPE html>"))).toBeNull();
    expect(sniffImageContentType(Buffer.from("%PDF-1.7"))).toBeNull();
    // A RIFF container that is not WebP (WAVE audio).
    expect(
      sniffImageContentType(Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ")),
    ).toBeNull();
    // An ISO media file that is not AVIF (MP4 video).
    expect(
      sniffImageContentType(Buffer.from("\x00\x00\x00\x18ftypisom")),
    ).toBeNull();
    expect(sniffImageContentType(Buffer.from([0x89, 0x50]))).toBeNull();
    // Only the first six PNG bytes: not a file mupdf-style loaders accept.
    expect(
      sniffImageContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
    ).toBeNull();
    expect(sniffImageContentType(Buffer.alloc(0))).toBeNull();
  });

  it.each(["avif", "avis"])("recognizes %s as a compatible brand", brand => {
    const bytes = fileTypeBox("mif1", ["miaf", brand]);
    expect(sniffImageContentType(bytes)).toBe("image/avif");
    expect(sniffImageContentTypeFromBase64(bytes.toString("base64"))).toBe(
      "image/avif",
    );
  });

  it("recognizes the existing AVIF fixture with a generic major brand", () => {
    const bytes = readFileSync(
      new URL("../../../test-site/public/ocr-fixture.avif", import.meta.url),
    );
    bytes.write("mif1", 8);
    expect(sniffImageContentType(bytes)).toBe("image/avif");
    expect(sniffImageContentTypeFromBase64(bytes.toString("base64"))).toBe(
      "image/avif",
    );
  });

  it("supports extended file-type boxes and Uint8Array views", () => {
    const box = fileTypeBox("mif1", ["miaf", "avif"], true);
    const padded = Buffer.concat([Buffer.alloc(7), box]);
    const bytes = new Uint8Array(
      padded.buffer,
      padded.byteOffset + 7,
      box.length,
    );
    expect(sniffImageContentType(bytes)).toBe("image/avif");
    expect(sniffImageContentTypeFromBase64(box.toString("base64"))).toBe(
      "image/avif",
    );
  });

  it("finds compatible brands beyond the first base64 chunk", () => {
    const bytes = fileTypeBox("mif1", [...Array(800).fill("miaf"), "avif"]);
    expect(sniffImageContentType(bytes)).toBe("image/avif");
    expect(sniffImageContentTypeFromBase64(bytes.toString("base64"))).toBe(
      "image/avif",
    );
  });

  it("keeps base64 decoding bounded to chunks of the file-type box", () => {
    const box = fileTypeBox("mif1", [...Array(800).fill("miaf"), "avif"]);
    const base64 = Buffer.concat([box, Buffer.alloc(1024 * 1024)]).toString(
      "base64",
    );
    const decode = vi.spyOn(Buffer, "from");
    let decodedCharacters: number[];
    let result: string | null;
    try {
      result = sniffImageContentTypeFromBase64(base64);
      decodedCharacters = decode.mock.calls
        .filter(args => args[1] === "base64")
        .map(args => (args[0] as string).length);
    } finally {
      decode.mockRestore();
    }
    expect(result).toBe("image/avif");
    expect(Math.max(...decodedCharacters)).toBeLessThanOrEqual(4096);
    expect(
      decodedCharacters.reduce((total, size) => total + size, 0),
    ).toBeLessThanOrEqual(Math.ceil(box.length / 3) * 4);
  });

  it("does not treat the minor version or later boxes as compatible brands", () => {
    const box = fileTypeBox("mif1", ["miaf"]);
    box.write("avif", 12);
    const bytes = Buffer.concat([
      box,
      Buffer.from("\x00\x00\x00\x10mdatavifavis"),
    ]);
    expect(sniffImageContentType(bytes)).toBeNull();
    expect(
      sniffImageContentTypeFromBase64(bytes.toString("base64")),
    ).toBeNull();
  });

  it("rejects incomplete and misaligned compatible brands", () => {
    const partial = fileTypeBox("mif1", ["avif"]).subarray(0, 19);
    const unaligned = fileTypeBox("mif1", ["xavi", "fxxx"]);
    const malformed = fileTypeBox("mif1", ["avif"]);
    malformed.writeUInt32BE(19, 0);
    for (const bytes of [partial, unaligned, malformed]) {
      expect(sniffImageContentType(bytes)).toBeNull();
      expect(
        sniffImageContentTypeFromBase64(bytes.toString("base64")),
      ).toBeNull();
    }
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
