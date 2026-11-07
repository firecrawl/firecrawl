import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { downloadMedia, retryDelay } from "./download.js";

let server: Server;
let base = "";
let root = "";
let leaked: string | undefined;
let attempts = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "archive-download-"));
  server = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/redirect") {
      res.writeHead(302, { Location: base.replace("127.0.0.1", "localhost") + "/received" });
      res.end();
      return;
    }
    if (path === "/received") leaked = req.headers.cookie ?? req.headers.authorization;
    if (path === "/retry") {
      attempts++;
      if (attempts < 3) {
        res.writeHead(429, { "Retry-After": "0" });
        res.end();
        return;
      }
    }
    if (path === "/html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("login");
      return;
    }
    if (path === "/stream") {
      res.writeHead(200, { "Content-Type": "application/x-mpegURL" });
      res.end("playlist");
      return;
    }
    res.setHeader("Content-Type", "image/png");
    if (path === "/large") res.setHeader("Content-Length", "1000");
    if (path === "/slow") {
      res.write(Buffer.alloc(1));
      const timer = setInterval(() => res.write(Buffer.alloc(1)), 20);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (path === "/chunked") {
      res.write(Buffer.alloc(20));
      res.end(Buffer.alloc(20));
      return;
    }
    res.end("image");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const headers = async (): Promise<Record<string, string>> => ({});

describe("media downloads", () => {
  it("streams media to a named asset file", async () => {
    const result = await downloadMedia(
      { url: `${base}/image`, kind: "image" },
      { root, maxBytes: 100, headers },
    );
    expect(result.status).toBe("downloaded");
    expect(result.bytes).toBe(5);
    expect(await readFile(join(root, result.path!), "utf8")).toBe("image");
  });

  it("rejects oversized files with and without Content-Length and leaves no partial files", async () => {
    for (const path of ["/large", "/chunked"]) {
      const result = await downloadMedia(
        { url: base + path, kind: "image" },
        { root, maxBytes: 10, headers },
      );
      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/size limit/);
    }
    expect((await readdir(root, { recursive: true })).some((name) => name.endsWith(".part"))).toBe(
      false,
    );
  });

  it("recomputes credentials for a cross-host redirect", async () => {
    const scoped = vi.fn(
      async (url: string): Promise<Record<string, string>> =>
        new URL(url).hostname === "127.0.0.1"
          ? { Cookie: "session=private", Authorization: "Bearer private" }
          : {},
    );
    const result = await downloadMedia(
      { url: `${base}/redirect`, kind: "image" },
      { root, maxBytes: 100, headers: scoped },
    );
    expect(result.status).toBe("downloaded");
    expect(scoped).toHaveBeenCalledTimes(2);
    expect(leaked).toBeUndefined();
  });

  it("backs off and retries 429 responses", async () => {
    const result = await downloadMedia(
      { url: `${base}/retry`, kind: "image" },
      { root, maxBytes: 100, headers },
    );
    expect(result.status).toBe("downloaded");
    expect(attempts).toBe(3);
    expect(retryDelay("2")).toBe(2000);
    expect(retryDelay("invalid", 20)).toBe(20);
  });

  it("records login responses as failures and streaming media as skipped", async () => {
    expect(
      (
        await downloadMedia(
          { url: `${base}/html`, kind: "image" },
          { root, maxBytes: 100, headers },
        )
      ).status,
    ).toBe("failed");
    expect(
      (
        await downloadMedia(
          { url: `${base}/stream`, kind: "video" },
          { root, maxBytes: 100, headers },
        )
      ).status,
    ).toBe("skipped");
  });

  it("aborts an in-flight stream and removes its partial file", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        downloadMedia(
          { url: `${base}/slow`, kind: "image" },
          {
            root,
            maxBytes: 100,
            headers,
            signal: controller.signal,
          },
        ),
      ).rejects.toThrow();
      expect(
        (await readdir(root, { recursive: true })).some((name) => name.endsWith(".part")),
      ).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });
});
