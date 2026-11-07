import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function checkoutRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (
    !existsSync(join(dir, "taskfile.yml")) ||
    !existsSync(join(dir, "apps/scraper/package.json"))
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

export function assetPath(url: string, kind: "image" | "video", contentType: string): string {
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
  };
  const suffix = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|mp4|m4v|mov|ogv|webm)$/i.exec(name)?.[0];
  const ext = mimeExtensions[contentType] ?? suffix ?? ".bin";
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  return `assets/${kind === "image" ? "images" : "videos"}/${stem}--${urlHash(url)}${ext}`;
}

export async function createRun(url: string, out?: string): Promise<string> {
  const hostDir = join(out ?? join(checkoutRoot(), "data"), safePart(new URL(url).host));
  await mkdir(hostDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return mkdtemp(join(hostDir, `${stamp}-`));
}
