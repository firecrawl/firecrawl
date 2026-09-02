// Raster image formats the image engine can hand to FirePDF for OCR: the
// formats FirePDF opens as a one-page image document (PNG, JPEG, TIFF, GIF,
// BMP). WebP, SVG, AVIF and HEIC are deliberately absent: FirePDF cannot open
// them, so they keep failing fast as unsupported files instead of burning a
// round trip.

const CONTENT_TYPE_TO_EXTENSION = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  // Non-standard but common in the wild.
  ["image/jpg", ".jpg"],
  ["image/pjpeg", ".jpg"],
  ["image/tiff", ".tif"],
  ["image/x-tiff", ".tif"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
  ["image/x-ms-bmp", ".bmp"],
]);

const EXTENSION_ALIASES = new Map<string, string>([
  [".jpeg", ".jpg"],
  [".tiff", ".tif"],
]);

export const IMAGE_EXTENSIONS = new Set([
  ...CONTENT_TYPE_TO_EXTENSION.values(),
  ...EXTENSION_ALIASES.keys(),
]);

export function imageExtensionFromContentType(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) return null;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_EXTENSION.get(mediaType) ?? null;
}

export function imageContentTypeFromExtension(
  extension: string,
): string | null {
  const lower = extension.toLowerCase();
  const ext = EXTENSION_ALIASES.get(lower) ?? lower;
  for (const [contentType, mapped] of CONTENT_TYPE_TO_EXTENSION) {
    if (mapped === ext) return contentType;
  }
  return null;
}

// Only matches at the end of the path: image URLs do not carry the
// mid-path `file.xlsx/hash` shape that document URLs sometimes do.
export function imageExtensionFromUrlPath(urlPath: string): string | null {
  const lowerPath = urlPath.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) return ext;
  }
  return null;
}

// Magic-byte signatures for the supported formats. Servers mislabel freely
// (`image/png;charset=UTF-8`, HTML error pages served as `image/jpeg`), so
// the bytes are the source of truth for whether OCR can open the file.
const MAGIC_SIGNATURES: Array<{ contentType: string; bytes: number[] }> = [
  {
    contentType: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { contentType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { contentType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { contentType: "image/tiff", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { contentType: "image/tiff", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { contentType: "image/bmp", bytes: [0x42, 0x4d] },
];

const SNIFF_WINDOW = Math.max(...MAGIC_SIGNATURES.map(s => s.bytes.length));

export function sniffImageContentType(bytes: Uint8Array): string | null {
  for (const { contentType, bytes: magic } of MAGIC_SIGNATURES) {
    if (bytes.length < magic.length) continue;
    let matches = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return contentType;
  }
  return null;
}

// Sniffs a base64 payload without decoding all of it: 4 base64 characters
// encode 3 bytes, so a short prefix covers the longest signature.
export function sniffImageContentTypeFromBase64(base64: string): string | null {
  const chars = Math.ceil(SNIFF_WINDOW / 3) * 4;
  return sniffImageContentType(Buffer.from(base64.slice(0, chars), "base64"));
}
