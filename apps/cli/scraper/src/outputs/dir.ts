import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OutputWriter } from "./types.js";

const RESERVED_CHARS = '<>:"|?*';

function sanitize(part: string): string {
  let out = "";
  for (const ch of part) {
    const code = ch.charCodeAt(0);
    if (code < 0x20) continue;
    out += RESERVED_CHARS.includes(ch) ? "_" : ch;
  }
  return out.replace(/\.+$/, "");
}

export function urlToRelPath(url: string, ext: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
    return `_invalid/${hash}${ext}`;
  }
  const host = sanitize(parsed.hostname || "_unknown");
  const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
  const queryHash = parsed.search
    ? `_${createHash("sha1").update(parsed.search).digest("hex").slice(0, 6)}`
    : "";
  if (!pathname) return `${host}/index${queryHash}${ext}`;
  const safe = pathname.split("/").map(sanitize).join("/");
  return `${host}/${safe}${queryHash}${ext}`;
}

export class DirWriter implements OutputWriter {
  readonly isStdout = false;
  private readonly used = new Set<string>();

  constructor(private readonly root: string) {}

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async write(url: string, content: string | Buffer, ext: string): Promise<void> {
    let rel = urlToRelPath(url, ext);
    if (this.used.has(rel)) {
      const hash = createHash("sha1").update(url).digest("hex").slice(0, 6);
      rel = rel.replace(new RegExp(`${ext.replace(".", "\\.")}$`), `_${hash}${ext}`);
    }
    this.used.add(rel);
    const target = join(this.root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async close(): Promise<void> {}
}
