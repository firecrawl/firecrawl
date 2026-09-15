import { describe, expect, it } from "vitest";
import { getKickoffSitemapUrls } from "./sitemap-kickoff";

describe("getKickoffSitemapUrls", () => {
  it("uses sitemap declarations and conventional locations for a redirect target", () => {
    expect(
      getKickoffSitemapUrls("https://www.example.org/docs?lang=en#top", [
        "https://www.example.org/sitemaps/main.xml",
      ]),
    ).toEqual([
      "https://www.example.org/sitemaps/main.xml",
      "https://www.example.org/docs/sitemap.xml",
      "https://www.example.org/sitemap.xml",
      "https://example.org/sitemap.xml",
    ]);
  });

  it("uses sitemap URLs directly, including signed URLs", () => {
    expect(
      getKickoffSitemapUrls(
        "https://www.example.org/sitemap.xml?signature=abc",
        [],
      ),
    ).toEqual(["https://www.example.org/sitemap.xml?signature=abc"]);
  });

  it("falls back to the hostname when no registrable domain exists", () => {
    const attempts = getKickoffSitemapUrls("http://localhost/docs", []);

    expect(attempts).toContain("http://localhost/sitemap.xml");
    expect(attempts).not.toContain("http://null/sitemap.xml");
  });
});
