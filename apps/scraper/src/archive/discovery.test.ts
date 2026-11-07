import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover, httpUrl, isPageUrl } from "./discovery.js";
import { assetPath, checkoutRoot, pagePath } from "./paths.js";

describe("archive discovery", () => {
  it("finds navigation, lazy/responsive images, posters, direct videos and embedded players", () => {
    const result = discover(
      `<base href="/docs/"><nav><a href="next#part">Next</a></nav>
      <img src="/logo.png" data-src="lazy.webp" srcset="small.jpg 1x, large.jpg 2x">
      <picture><source srcset="wide.avif 800w"></picture>
      <meta property="og:image" content="/social.jpg">
      <video poster="poster.png"><source src="clip.mp4"></video>
      <a href="stream.m3u8">Stream</a><iframe src="https://player.example.com/embed/1"></iframe>
      <div style="background: url('/bg.png')"></div><img src="data:image/png;base64,abcd">`,
      "https://example.com/start",
    );
    expect(result.links).toContain("https://example.com/docs/next");
    const urls = result.media.map((m) => m.url);
    for (const path of [
      "/logo.png",
      "/docs/lazy.webp",
      "/docs/small.jpg",
      "/docs/large.jpg",
      "/docs/wide.avif",
      "/social.jpg",
      "/docs/poster.png",
      "/docs/clip.mp4",
      "/bg.png",
    ]) {
      expect(urls).toContain(`https://example.com${path}`);
    }
    expect(result.media.find((m) => m.url.endsWith("stream.m3u8"))?.skipReason).toMatch(
      /Streaming/,
    );
    expect(result.media.find((m) => m.kind === "embed")?.skipReason).toMatch(/Embedded/);
    expect(urls.some((url) => url.startsWith("data:"))).toBe(false);
  });

  it("ignores SVG-local filter references inside inline data images", () => {
    const result = discover(
      `<div style="background: url(data:image/svg+xml,filter:url(%23b))"></div>
      <div style="filter: url(#filter)"></div><video src="blob:https://example.com/id"></video>`,
      "https://example.com/",
    );
    expect(result.media.filter((m) => m.kind === "image")).toEqual([]);
    expect(result.media.find((m) => m.kind === "video")?.skipReason).toMatch(/Browser-local/);
  });

  it("enforces origin, skips binary/action URLs, and retains distinct queries", () => {
    for (const path of [
      "/logout",
      "/sign-out",
      "/users/delete/1",
      "/?action=logout",
      "/clip.mp4",
      "/sheet.pdf",
    ]) {
      expect(isPageUrl(`https://example.com${path}`, "https://example.com")).toBe(false);
    }
    expect(isPageUrl("https://other.example.com/", "https://example.com")).toBe(false);
    expect(isPageUrl("https://example.com/a?x=1", "https://example.com")).toBe(true);
    expect(httpUrl("https://example.com/a?x=1#part")).toBe("https://example.com/a?x=1");
    expect(httpUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpUrl("https://user:password@example.com/")).toBeUndefined();
  });
});

describe("archive paths", () => {
  it("locates the checkout and keeps URL variants in separate readable folders", () => {
    expect(existsSync(join(checkoutRoot(), "taskfile.yml"))).toBe(true);
    expect(pagePath("https://example.com/docs/start")).toMatch(
      /^pages\/docs\/start--[a-f0-9]{16}$/,
    );
    expect(pagePath("https://example.com/")).toMatch(/^pages\/_root--/);
    expect(pagePath("https://example.com/a?x=1")).not.toBe(pagePath("https://example.com/a?x=2"));
  });

  it("sanitizes encoded separators, reserved filenames and media names", () => {
    expect(pagePath("https://example.com/%2F..%2F/CON")).not.toContain("../");
    expect(pagePath("https://example.com/%2F..%2F/CON")).toContain("/_CON--");
    expect(assetPath("https://cdn.example.com/image?id=1", "image", "image/png")).toMatch(
      /^assets\/images\/image--[a-f0-9]{16}\.png$/,
    );
  });
});
