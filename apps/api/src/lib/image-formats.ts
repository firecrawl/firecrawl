// Raster image formats the image engine can hand to FirePDF for OCR: the
// formats FirePDF opens as a one-page image document (PNG, JPEG, JPEG 2000,
// TIFF, GIF, BMP), plus WebP and AVIF, which FirePDF transcodes to PNG before
// opening them. SVG and HEIC are deliberately absent: FirePDF cannot open
// them, so they keep failing fast as unsupported files instead of burning a
// round trip.

export const IMAGE_CONTENT_TYPE_TO_EXTENSION: ReadonlyMap<string, string> =
  new Map<string, string>([
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
    // JPEG 2000: the JP2 container digitized book scans and IIIF tile sources
    // are served in, and its extended JPX sibling. Raw codestreams (.j2k,
    // .j2c) share the type: FirePDF opens them the same way.
    ["image/jp2", ".jp2"],
    ["image/jpx", ".jp2"],
    // Raw codestreams have no registered type; these are the labels servers
    // use for them.
    ["image/j2k", ".jp2"],
    ["image/j2c", ".jp2"],
    ["image/x-j2c", ".jp2"],
    // WebP and AVIF: what CDNs serve to a browser that advertises them in
    // Accept, whatever the URL's extension says. FirePDF transcodes both.
    ["image/webp", ".webp"],
    ["image/avif", ".avif"],
  ]);

export const IMAGE_EXTENSION_ALIASES: ReadonlyMap<string, string> = new Map<
  string,
  string
>([
  [".jpeg", ".jpg"],
  [".tiff", ".tif"],
  [".jpx", ".jp2"],
  [".jpf", ".jp2"],
  [".j2k", ".jp2"],
  [".j2c", ".jp2"],
]);

export const IMAGE_EXTENSIONS = new Set([
  ...IMAGE_CONTENT_TYPE_TO_EXTENSION.values(),
  ...IMAGE_EXTENSION_ALIASES.keys(),
]);

export function imageExtensionFromContentType(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) return null;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return IMAGE_CONTENT_TYPE_TO_EXTENSION.get(mediaType) ?? null;
}

export function imageContentTypeFromExtension(
  extension: string,
): string | null {
  const lower = extension.toLowerCase();
  const ext = IMAGE_EXTENSION_ALIASES.get(lower) ?? lower;
  for (const [contentType, mapped] of IMAGE_CONTENT_TYPE_TO_EXTENSION) {
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
// the bytes are the source of truth for whether OCR can open the file. A
// `null` position matches any byte: container formats carry a length field
// ahead of their tag.
const MAGIC_SIGNATURES: Array<{
  contentType: string;
  bytes: Array<number | null>;
}> = [
  {
    contentType: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { contentType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { contentType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { contentType: "image/tiff", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { contentType: "image/tiff", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { contentType: "image/bmp", bytes: [0x42, 0x4d] },
  // JPEG 2000: the JP2/JPX container's 12-byte signature box, and a raw
  // codestream (SOC then SIZ marker). FirePDF opens both through the same
  // loader, so both report the container type.
  {
    contentType: "image/jp2",
    bytes: [
      0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    ],
  },
  { contentType: "image/jp2", bytes: [0xff, 0x4f, 0xff, 0x51] },
  // WebP: RIFF header, 4-byte chunk size, then the WEBP form type.
  {
    contentType: "image/webp",
    bytes: [
      0x52,
      0x49,
      0x46,
      0x46,
      null,
      null,
      null,
      null,
      0x57,
      0x45,
      0x42,
      0x50,
    ],
  },
  // AVIF: an ISO media file whose first box is `ftyp` with the `avif` brand
  // (still image) or `avis` (image sequence; the first frame is OCR'd).
  {
    contentType: "image/avif",
    bytes: [
      null,
      null,
      null,
      null,
      0x66,
      0x74,
      0x79,
      0x70,
      0x61,
      0x76,
      0x69,
      0x66,
    ],
  },
  {
    contentType: "image/avif",
    bytes: [
      null,
      null,
      null,
      null,
      0x66,
      0x74,
      0x79,
      0x70,
      0x61,
      0x76,
      0x69,
      0x73,
    ],
  },
];

// Include the largest ftyp header (64-bit box size, major brand and minor
// version), so compatible brands can be scanned without decoding image data.
const SNIFF_WINDOW =
  Math.ceil(Math.max(24, ...MAGIC_SIGNATURES.map(s => s.bytes.length)) / 12) *
  12;

function fileTypeBox(
  bytes: Uint8Array,
): { brandStart: number; end: number } | null {
  if (
    bytes.length < 16 ||
    bytes[4] !== 0x66 ||
    bytes[5] !== 0x74 ||
    bytes[6] !== 0x79 ||
    bytes[7] !== 0x70
  )
    return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = view.getUint32(0);
  let brandStart = 8;
  if (end === 1) {
    if (bytes.length < 24) return null;
    const extendedSize = view.getBigUint64(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    end = Number(extendedSize);
    brandStart = 16;
  }
  if (end < brandStart + 8 || end % 4 !== 0) return null;
  return { brandStart, end };
}

function hasAvifBrand(bytes: Uint8Array, start: number, end: number): boolean {
  for (
    let offset = start;
    offset + 4 <= Math.min(end, bytes.length);
    offset += 4
  ) {
    if (
      bytes[offset] === 0x61 &&
      bytes[offset + 1] === 0x76 &&
      bytes[offset + 2] === 0x69 &&
      (bytes[offset + 3] === 0x66 || bytes[offset + 3] === 0x73)
    )
      return true;
  }
  return false;
}

export function sniffImageContentType(bytes: Uint8Array): string | null {
  for (const { contentType, bytes: magic } of MAGIC_SIGNATURES) {
    if (bytes.length < magic.length) continue;
    let matches = true;
    for (let i = 0; i < magic.length; i++) {
      if (magic[i] !== null && bytes[i] !== magic[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return contentType;
  }
  // AVIF can declare avif/avis in compatible_brands while using mif1/msf1
  // as its major brand. Only aligned brands within ftyp count: minor_version
  // and subsequent boxes may contain the same bytes without declaring AVIF.
  const box = fileTypeBox(bytes);
  if (
    box &&
    (hasAvifBrand(bytes, box.brandStart, box.brandStart + 4) ||
      hasAvifBrand(bytes, box.brandStart + 8, box.end))
  )
    return "image/avif";
  return null;
}

// Sniffs a base64 payload without decoding all of it: 4 base64 characters
// encode 3 bytes, so a short prefix covers the longest signature.
export function sniffImageContentTypeFromBase64(base64: string): string | null {
  const chars = Math.ceil(SNIFF_WINDOW / 3) * 4;
  const prefix = Buffer.from(base64.slice(0, chars), "base64");
  const contentType = sniffImageContentType(prefix);
  if (contentType) return contentType;

  const box = fileTypeBox(prefix);
  if (!box) return null;

  // 4096 base64 characters decode to 3072 bytes: both are aligned to whole
  // 4-byte brands. Walk only ftyp, with bounded memory even if its advertised
  // size is large; do not decode the image payload after the box.
  const end = Math.min(box.end, Math.floor((base64.length * 3) / 4));
  for (let offset = SNIFF_WINDOW; offset + 4 <= end; offset += 3072) {
    const startChar = (offset / 3) * 4;
    const endChar = Math.ceil(Math.min(offset + 3072, end) / 3) * 4;
    const chunk = Buffer.from(base64.slice(startChar, endChar), "base64");
    if (hasAvifBrand(chunk, 0, end - offset)) return "image/avif";
  }
  return null;
}
