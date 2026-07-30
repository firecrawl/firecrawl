import { gzipSync } from "node:zlib";
import { decodeSitemapFileBuffer } from "../downloadFile";

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

describe("decodeSitemapFileBuffer", () => {
  it("decompresses gzipped sitemap XML (happy path)", async () => {
    const gzipped = gzipSync(Buffer.from(SITEMAP_XML, "utf-8"));
    // sanity: gzip magic bytes
    expect(gzipped[0]).toBe(0x1f);
    expect(gzipped[1]).toBe(0x8b);

    const decoded = await decodeSitemapFileBuffer(gzipped);
    expect(decoded).toBe(SITEMAP_XML);
    expect(decoded).toContain("https://example.com/a");
  });

  it("returns already-decompressed XML as-is when a .gz URL serves plain XML", async () => {
    // Some servers transparently decompress or mislabel the extension; the
    // body is plain XML, not gzip. It must not be fed into gunzip.
    const buffer = Buffer.from(SITEMAP_XML, "utf-8");
    const decoded = await decodeSitemapFileBuffer(buffer);
    expect(decoded).toBe(SITEMAP_XML);
  });

  it("does not throw on a non-gzip body (e.g. a bot-wall HTML challenge)", async () => {
    // Failure path: previously this was passed straight into gunzip and threw,
    // silently collapsing the sitemap to zero links.
    const html = Buffer.from(
      "<!DOCTYPE html><html><body>Access Denied</body></html>",
      "utf-8",
    );
    const decoded = await decodeSitemapFileBuffer(html);
    expect(decoded).toContain("Access Denied");
  });

  it("rejects when content claims gzip magic bytes but is corrupt", async () => {
    const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);
    await expect(decodeSitemapFileBuffer(corrupt)).rejects.toThrow();
  });
});
