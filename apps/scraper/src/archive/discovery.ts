import { JSDOM } from "jsdom";

export interface MediaRef {
  url: string;
  kind: "image" | "video" | "embed";
  skipReason?: string;
}

const IMAGE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:$|[?#])/i;
const VIDEO = /\.(?:mp4|m4v|mov|ogv|webm)(?:$|[?#])/i;
const STREAM = /\.(?:m3u8|mpd)(?:$|[?#])/i;
const NON_PAGE =
  /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|mp4|m4v|mov|ogv|webm|mp3|wav|ogg|m3u8|mpd|pdf|zip|gz|css|js|woff2?|ttf)(?:$|[?#])/i;
const ACTION =
  /(?:^|[/_-])(?:log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off|delete|remove)(?:$|[/_-])/i;

export function httpUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export function isPageUrl(value: string, origin: string): boolean {
  const normalized = httpUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  if (url.origin !== origin || NON_PAGE.test(url.pathname)) return false;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (ACTION.test(path)) return false;
  return ![...url.searchParams].some(
    ([key, val]) => /^(?:action|do|event|command)$/i.test(key) && ACTION.test(val),
  );
}

export function discover(html: string, pageUrl: string): { links: string[]; media: MediaRef[] } {
  const dom = new JSDOM(html, { url: pageUrl });
  try {
    const doc = dom.window.document;
    const base =
      httpUrl(doc.querySelector("base[href]")?.getAttribute("href") ?? "", pageUrl) ?? pageUrl;
    const links = new Set<string>();
    const media = new Map<string, MediaRef>();
    const add = (value: string | null | undefined, kind: MediaRef["kind"]): void => {
      if (!value?.trim() || /^(?:#|%23)/i.test(value.trim())) return;
      if (value.trim().startsWith("blob:")) {
        media.set(value.trim(), { url: value.trim(), kind, skipReason: "Browser-local media URL" });
        return;
      }
      const url = httpUrl(value.trim(), base);
      if (!url) return;
      const skipReason =
        kind === "embed"
          ? "Embedded player; URL retained"
          : STREAM.test(url)
            ? "Streaming manifest; direct files only"
            : undefined;
      const ref: MediaRef = { url, kind, ...(skipReason ? { skipReason } : {}) };
      if (!media.has(url) || (media.get(url)?.kind === "embed" && kind !== "embed"))
        media.set(url, ref);
    };
    for (const a of doc.querySelectorAll("a[href]")) {
      const value = a.getAttribute("href") ?? "";
      const url = httpUrl(value, base);
      if (!url) continue;
      links.add(url);
      if (IMAGE.test(url)) add(url, "image");
      else if (VIDEO.test(url) || STREAM.test(url)) add(url, "video");
    }
    for (const img of doc.querySelectorAll("img")) {
      for (const attr of ["src", "data-src", "data-original", "data-lazy-src"])
        add(img.getAttribute(attr), "image");
    }
    for (const el of doc.querySelectorAll("img, picture source")) {
      for (const attr of ["srcset", "data-srcset"]) {
        for (const candidate of (el.getAttribute(attr) ?? "").split(","))
          add(candidate.trim().split(/\s+/)[0], "image");
      }
    }
    for (const el of doc.querySelectorAll("video")) {
      add(el.getAttribute("src"), "video");
      add(el.getAttribute("poster"), "image");
    }
    for (const el of doc.querySelectorAll("video source")) add(el.getAttribute("src"), "video");
    for (const el of doc.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]'))
      add(el.getAttribute("content"), "image");
    for (const el of doc.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
    ))
      add(el.getAttribute("content"), "video");
    for (const el of doc.querySelectorAll("iframe[src], embed[src]"))
      add(el.getAttribute("src"), "embed");
    for (const el of doc.querySelectorAll("[style]")) {
      for (const match of (el.getAttribute("style") ?? "").matchAll(
        /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
      ))
        add(match[1], "image");
    }
    return { links: [...links], media: [...media.values()] };
  } finally {
    dom.window.close();
  }
}
