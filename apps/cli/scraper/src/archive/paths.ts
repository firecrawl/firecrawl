import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function checkoutRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (
    !existsSync(join(dir, "taskfile.yml")) ||
    !existsSync(join(dir, "apps/cli/scraper/package.json"))
  ) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot locate checkout root; pass --out explicitly");
    dir = parent;
  }
  return dir;
}

export function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function safePart(value: string): string {
  try {
    value = decodeURIComponent(value);
  } catch {
    /* Keep malformed escapes as literal text. */
  }
  const safe = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 70);
  return !safe || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}

export function pagePath(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean).map(safePart);
  const leaf = segments.pop() ?? "_root";
  return ["pages", ...segments.slice(0, 12), `${leaf}--${urlHash(url)}`].join("/");
}

const ASSET_DIRS = { image: "images", video: "videos", audio: "audio" } as const;

export function assetPath(url: string, kind: keyof typeof ASSET_DIRS, contentType: string): string {
  const name = safePart(new URL(url).pathname.split("/").pop() || kind);
  const mimeExtensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "image/x-icon": ".ico",
    "image/bmp": ".bmp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/ogg": ".ogv",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "application/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/flac": ".flac",
    "audio/webm": ".weba",
  };
  const suffix =
    /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|mp4|m4v|mov|ogv|webm|mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i.exec(
      name,
    )?.[0];
  const ext = mimeExtensions[contentType] ?? suffix ?? ".bin";
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  return `assets/${ASSET_DIRS[kind]}/${stem}--${urlHash(url)}${ext}`;
}

export async function createRun(url: string, out?: string): Promise<string> {
  const hostDir = join(out ?? join(checkoutRoot(), "data"), safePart(new URL(url).host));
  await mkdir(hostDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return mkdtemp(join(hostDir, `${stamp}-`));
}
