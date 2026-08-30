import { detectIsobmffMime } from "../specialtyHandler";

// Builds a minimal 24-byte ISOBMFF "ftyp" box with the given major brand,
// matching what real AVIF/HEIC/MP4 files have at byte offset 0.
function ftypBox(brand: string): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(24, 0); // box size
  head.write("ftyp", 4, "ascii");
  head.write(brand, 8, "ascii");
  // bytes 12-15: minor version (zeros)
  head.write(brand, 16, "ascii"); // one compatible brand
  // bytes 20-23: padding (zeros)
  return head;
}

describe("detectIsobmffMime", () => {
  it("detects AVIF (avif brand)", () => {
    expect(detectIsobmffMime(ftypBox("avif"))).toBe("image/avif");
  });

  it("detects animated AVIF (avis brand)", () => {
    expect(detectIsobmffMime(ftypBox("avis"))).toBe("image/avif");
  });

  it("detects HEIC (heic brand)", () => {
    expect(detectIsobmffMime(ftypBox("heic"))).toBe("image/heic");
  });

  it("detects HEIF (mif1 brand)", () => {
    expect(detectIsobmffMime(ftypBox("mif1"))).toBe("image/heif");
  });

  it("detects MP4 (isom brand)", () => {
    expect(detectIsobmffMime(ftypBox("isom"))).toBe("video/mp4");
  });

  it("detects QuickTime (qt brand with trailing spaces)", () => {
    expect(detectIsobmffMime(ftypBox("qt  "))).toBe("video/quicktime");
  });

  it("returns null for an unknown ftyp brand", () => {
    expect(detectIsobmffMime(ftypBox("zzzz"))).toBeNull();
  });

  it("rejects buffers shorter than 12 bytes", () => {
    expect(detectIsobmffMime(Buffer.alloc(0))).toBeNull();
    expect(
      detectIsobmffMime(
        Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61]),
      ),
    ).toBeNull();
  });

  it("rejects HTML content", () => {
    expect(
      detectIsobmffMime(
        Buffer.from("<!DOCTYPE html><html><body>not an image</body></html>"),
      ),
    ).toBeNull();
  });

  it("rejects PDF content", () => {
    expect(detectIsobmffMime(Buffer.from("%PDF-1.4 rest of file..."))).toBeNull();
  });

  it("rejects a ZIP archive", () => {
    expect(
      detectIsobmffMime(
        Buffer.from([
          0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00,
          0x00, 0x00, 0x00,
        ]),
      ),
    ).toBeNull();
  });
});
