import { JSDOM } from "jsdom";

export interface MediaRef {
  url: string;
  kind: "image" | "video" | "audio" | "embed";
  skipReason?: string;
}

const IMAGE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:$|[?#])/i;
const VIDEO = /\.(?:mp4|m4v|mov|ogv|webm)(?:$|[?#])/i;
const AUDIO = /\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)(?:$|[?#])/i;
const STREAM = /\.(?:m3u8|mpd)(?:$|[?#])/i;
const NON_PAGE =
  /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|mp4|m4v|mov|ogv|webm|mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|m3u8|mpd|pdf|zip|gz|css|js|woff2?|ttf)(?:$|[?#])/i;
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
      else if (AUDIO.test(url)) add(url, "audio");
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
    for (const el of doc.querySelectorAll("audio[src], audio source[src]"))
      add(el.getAttribute("src"), "audio");
    for (const el of doc.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]'))
      add(el.getAttribute("content"), "image");
    for (const el of doc.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
    ))
      add(el.getAttribute("content"), "video");
    for (const el of doc.querySelectorAll(
      'meta[property="og:audio"], meta[property="og:audio:url"], meta[property="og:audio:secure_url"]',
    ))
      add(el.getAttribute("content"), "audio");
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

/** A media response the browser fetched, or a media element's resolved source. */
export interface CapturedMedia {
  url: string;
  contentType?: string;
}

function capturedKind(url: string, contentType: string): "video" | "audio" | undefined {
  if (/(?:mpegurl|dash\+xml)/.test(contentType) || STREAM.test(url)) return "video";
  if (contentType.startsWith("audio/") || contentType === "application/ogg") return "audio";
  if (contentType.startsWith("video/")) return "video";
  if (contentType && contentType !== "application/octet-stream") return undefined;
  if (AUDIO.test(url)) return "audio";
  if (VIDEO.test(url)) return "video";
  return undefined;
}

/**
 * Append media the browser actually loaded (often set by scripts after the
 * markup was written) to the media discovered in the page's HTML.
 */
export function mergeCaptured(
  media: MediaRef[],
  captured: readonly CapturedMedia[] | undefined,
): MediaRef[] {
  const merged = new Map(media.map((ref) => [ref.url, ref]));
  for (const item of captured ?? []) {
    const url = httpUrl(item.url);
    if (!url || merged.has(url)) continue;
    const type = (item.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const kind = capturedKind(url, type);
    if (!kind) continue;
    const streaming = /(?:mpegurl|dash\+xml)/.test(type) || STREAM.test(url);
    merged.set(url, {
      url,
      kind,
      ...(streaming ? { skipReason: "Streaming manifest; direct files only" } : {}),
    });
  }
  return [...merged.values()];
}
