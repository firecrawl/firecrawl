import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { checkoutRoot, createRun } from "../archive/paths.js";
import type { Manifest } from "../archive/storage.js";
import { loadConfig } from "../config.js";
import { mediaHeaders, parseMediaKinds, runArchive, type ArchiveOptions } from "./archive.js";

let server: Server;
let base = "";
let out = "";
let mediaRequests = 0;
const pageRequests: string[] = [];

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "archive-command-"));
  server = createServer(async (req, res) => {
    if (req.url === "/") {
      res.end("API fixture");
      return;
    }
    if (req.url === "/shared.png") {
      mediaRequests++;
      res.setHeader("Content-Type", "image/png");
      res.end("image");
      return;
    }
    if (req.url === "/movie.mp4") {
      res.setHeader("Content-Type", "video/mp4");
      res.end("video");
      return;
    }
    if (req.url === "/listen.mp3" || req.url === "/track?id=7") {
      res.setHeader("Content-Type", "audio/mpeg");
      res.end("audio");
      return;
    }
    if (req.url === "/missing.png") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url !== "/v1/scrape") {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const payload = JSON.parse(raw) as {
      url: string;
      formats: string[];
      onlyMainContent: boolean;
      actions?: unknown;
    };
    const path = new URL(payload.url).pathname;
    pageRequests.push(path + new URL(payload.url).search);
    expect(payload.formats).toEqual(["markdown", "html", "rawHtml", "links"]);
    expect(payload.onlyMainContent).toBe(false);
    expect(payload.actions).toBeUndefined();
    const html = `<html><head><title>${path}</title></head><body><nav>
      <a href="/page?lang=en#section">English</a><a href="/page?lang=en">Duplicate</a>
      <a href="/page?lang=fr">French</a><a href="/simple">Cycle</a>
      <a href="/logout">Logout</a><a href="https://outside.example/">External</a></nav>
      <main>Fixture ${path}</main><img src="${base}/shared.png">
      <video src="${base}/movie.mp4"></video><iframe src="https://player.example/embed"></iframe>
      ${path === "/partial" ? '<a href="/blocked">Blocked</a><img src="/missing.png">' : ""}
      ${path === "/listening" ? `<audio src="${base}/listen.mp3"></audio>` : ""}</body></html>`;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        data: {
          markdown: `# Fixture ${path}`,
          html,
          rawHtml: html,
          links: [],
          ...(path === "/listening"
            ? { mediaRequests: [{ url: `${base}/track?id=7`, contentType: "audio/mpeg" }] }
            : {}),
          metadata: {
            url: payload.url,
            sourceURL: payload.url,
            title: path,
            statusCode: path === "/blocked" ? 403 : 200,
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(out, { recursive: true, force: true });
});

async function options(path = "/simple"): Promise<ArchiveOptions> {
  const config = await loadConfig();
  config.apiUrl = base;
  config.profiles["default"] = {
    engine: "cdp",
    formats: ["markdown"],
    actions: [{ type: "click" }],
  };
  return {
    url: base + path,
    config,
    profileName: "default",
    engineName: "api",
    cdpUrlOverride: undefined,
    out,
    limit: 10,
    maxMediaMb: 1,
    delayMs: 0,
  };
}

async function verifyIndex(root: string): Promise<void> {
  const index = await readFile(join(root, "index.md"), "utf8");
  for (const match of index.matchAll(/\]\(([^)]+)\)/g))
    await readFile(join(root, decodeURI(match[1]!)));
}

describe("site archives", () => {
  it("crawls through the API, deduplicates pages/assets, and writes navigable bundles", async () => {
    mediaRequests = 0;
    pageRequests.length = 0;
    const { root, manifest } = await runArchive(await options());
    expect(root.startsWith(out)).toBe(true);
    expect(manifest.status).toBe("completed");
    expect(manifest.pages).toHaveLength(3);
    expect(manifest.pages.every((p) => p.status === "saved")).toBe(true);
    expect(pageRequests).toEqual(["/simple", "/page?lang=en", "/page?lang=fr"]);
    expect(mediaRequests).toBe(1);
    expect(manifest.assets.filter((a) => a.status === "downloaded")).toHaveLength(2);
    expect(manifest.assets.find((a) => a.kind === "embed")?.status).toBe("skipped");
    expect(new Set(manifest.pages.map((p) => p.path)).size).toBe(3);
    for (const page of manifest.pages) {
      expect(await readFile(join(root, page.path, "raw.html"), "utf8")).toContain("<nav>");
      const saved = await readFile(join(root, page.path, "page.json"), "utf8");
      expect(saved).toContain("sourceURL");
    }
    await verifyIndex(root);
    const savedManifest = JSON.parse(
      await readFile(join(root, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(savedManifest).toEqual(manifest);
  });

  it("saves audio from markup and from media the engine saw loading", async () => {
    const { root, manifest } = await runArchive({ ...(await options("/listening")), limit: 1 });
    const audio = manifest.assets.filter((a) => a.kind === "audio");
    expect(audio.map((a) => [a.url, a.status])).toEqual([
      [`${base}/listen.mp3`, "downloaded"],
      [`${base}/track?id=7`, "downloaded"],
    ]);
    for (const asset of audio) expect(asset.path).toMatch(/^assets\/audio\/.+\.mp3$/);
    const saved = await Promise.all(audio.map((a) => readFile(join(root, a.path!), "utf8")));
    expect(saved).toEqual(["audio", "audio"]);
    expect(manifest.settings.playMedia).toBe(false);
    await verifyIndex(root);
  });

  it("downloads only the selected media kinds", async () => {
    const { manifest } = await runArchive({
      ...(await options("/listening")),
      limit: 1,
      media: ["audio"],
    });
    const byKind = (kind: string) =>
      manifest.assets.filter((a) => a.kind === kind).map((a) => [a.status, a.reason]);
    expect(byKind("audio")).toEqual([
      ["downloaded", undefined],
      ["downloaded", undefined],
    ]);
    expect(byKind("image")).toEqual([["skipped", "Media type not selected"]]);
    expect(byKind("video")).toEqual([["skipped", "Media type not selected"]]);
    expect(byKind("embed")).toEqual([["skipped", "Media type not selected"]]);
    expect(manifest.settings.media).toEqual(["audio"]);
  });

  it("transcribes downloaded audio and video while the crawl continues", async () => {
    pageRequests.length = 0;
    const started: string[] = [];
    const settings = {
      whisper: { bin: "unused", model: "/models/ggml-test.bin" },
      language: "auto",
      threads: 1,
      gpu: false,
    };
    const { root, manifest } = await runArchive({
      ...(await options("/listening")),
      limit: 2,
      transcribe: {
        workers: 2,
        settings,
        // Finishing only once a later page was crawled proves the crawl did not wait.
        runner: async (input, outBase) => {
          started.push(input);
          await vi.waitFor(() => expect(pageRequests.length).toBeGreaterThanOrEqual(2), {
            timeout: 5000,
          });
          return {
            files: [".srt", ".vtt", ".json", ".txt"].map((ext) => outBase + ext),
            language: "en",
            durationSec: 3,
            segments: 2,
          };
        },
      },
    });
    expect(manifest.status).toBe("completed");
    expect(started).toHaveLength(3);
    expect(manifest.settings.transcribe).toEqual({
      workers: 2,
      language: "auto",
      model: "ggml-test.bin",
    });
    const transcripts = manifest.transcripts ?? [];
    expect(transcripts.map((t) => t.asset).toSorted()).toEqual(
      [`${base}/listen.mp3`, `${base}/movie.mp4`, `${base}/track?id=7`].toSorted(),
    );
    for (const t of transcripts) {
      expect(t.status).toBe("transcribed");
      expect(t.segments).toBe(2);
      expect(t.files?.[3]).toMatch(/^transcripts\/.+--[0-9a-f]+\.txt$/);
    }
    const index = await readFile(join(root, "index.md"), "utf8");
    expect(index).toContain("## Transcripts");
    expect(index).toMatch(/2 segments, 3s · \[SRT\]/);
  });

  it("marks the archive partial when a transcription fails", async () => {
    const { manifest } = await runArchive({
      ...(await options("/listening")),
      limit: 1,
      media: ["audio"],
      transcribe: {
        workers: 1,
        settings: {
          whisper: { bin: "unused", model: "unused" },
          language: "en",
          threads: 1,
          gpu: false,
        },
        runner: async () => {
          throw new Error("whisper-cli exited with 1");
        },
      },
    });
    expect(manifest.status).toBe("partial");
    expect(manifest.transcripts?.map((t) => [t.status, t.reason])).toEqual([
      ["failed", "whisper-cli exited with 1"],
      ["failed", "whisper-cli exited with 1"],
    ]);
  });

  it("refuses to transcribe when whisper is not installed", async () => {
    await expect(
      runArchive({
        ...(await options("/listening")),
        transcribe: {
          workers: 1,
          settings: {
            whisper: { bin: "/nonexistent/whisper-cli", model: "/nonexistent/model.bin" },
            language: "auto",
            threads: 1,
            gpu: true,
          },
        },
      }),
    ).rejects.toThrow(/Transcription is not set up/);
  });

  it("rejects unknown --media kinds", () => {
    expect(parseMediaKinds("audio, Video,audio")).toEqual(["audio", "video"]);
    expect(() => parseMediaKinds("audio,pdf")).toThrow(/--media expects/);
    expect(() => parseMediaKinds(" , ")).toThrow(/--media expects/);
  });

  it("shows media counts, completed downloads and reused assets on stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runArchive(await options());
      const output = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("captured page; 3 media items to process");
      expect(output).toMatch(/media \[1\/3\].*downloaded 5 B/);
      expect(output).toMatch(/media \[1\/3\].*reused/);
      expect(output).toContain("skipped: Embedded player");
    } finally {
      stderr.mockRestore();
    }
  });

  it("stops normally at the page limit and creates distinct run directories", async () => {
    const opts = { ...(await options()), limit: 1 };
    const a = await runArchive(opts);
    const b = await runArchive(opts);
    expect(a.root).not.toBe(b.root);
    expect(a.manifest.pages).toHaveLength(1);
    expect(a.manifest.limitReached).toBe(true);
    expect(a.manifest.status).toBe("completed");
  });

  it("preserves successes and records page and download failures", async () => {
    const { root, manifest } = await runArchive(await options("/partial"));
    expect(manifest.status).toBe("partial");
    expect(manifest.pages.find((p) => p.url.endsWith("/blocked"))?.reason).toContain("403");
    expect(manifest.assets.find((a) => a.url.endsWith("missing.png"))?.status).toBe("failed");
    expect(manifest.pages.some((p) => p.status === "saved")).toBe(true);
    await verifyIndex(root);
  });

  it("finalizes an interrupted run without leaving temporary files", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      const { root, manifest } = await runArchive({
        ...(await options()),
        delayMs: 1000,
        signal: controller.signal,
      });
      expect(manifest.status).toBe("interrupted");
      expect(manifest.finishedAt).toBeDefined();
      expect(
        (await readdir(root, { recursive: true })).some((name) => /\.(?:part|tmp)$/.test(name)),
      ).toBe(false);
      await verifyIndex(root);
    } finally {
      clearTimeout(timer);
    }
  });

  it("rejects invalid limits and stdout before any archive is created", async () => {
    for (const changes of [
      { limit: 0 },
      { limit: 1.5 },
      { delayMs: -1 },
      { maxMediaMb: Infinity },
      { out: "-" },
      { url: "file:///etc/passwd" },
      { playMedia: true },
    ]) {
      await expect(runArchive({ ...(await options()), ...changes })).rejects.toThrow();
    }
  });

  it("uses checkout data by default and keeps it ignored", async () => {
    const host = `archive-fixture-${Date.now()}.example`;
    const root = await createRun(`https://${host}/`);
    try {
      expect(root.startsWith(join(checkoutRoot(), "data", host))).toBe(true);
      const result = await promisify(execFile)(
        "git",
        ["check-ignore", join(root, "manifest.json")],
        { cwd: checkoutRoot() },
      );
      expect(result.stdout).toContain("manifest.json");
    } finally {
      await rm(join(checkoutRoot(), "data", host), { recursive: true, force: true });
    }
  });

  it("exposes two Task shortcuts that force their respective engines and pass URL arguments through", async () => {
    // Read the Taskfile instead of running the task binary, so tests need no Task install.
    const taskfile = parse(await readFile(join(checkoutRoot(), "taskfile.yml"), "utf8")) as {
      tasks: Record<string, { dir?: string; env?: Record<string, string>; cmds?: string[] }>;
    };
    for (const name of ["api", "cdp"]) {
      const shortcut = taskfile.tasks[`scrape:all:${name}`];
      expect(shortcut?.dir).toBe("apps/cli/scraper");
      expect(shortcut?.env?.["SCRAPER_INVOKE_CWD"]).toBe("{{.USER_WORKING_DIR}}");
      // The forced --engine comes after the user's arguments, so it always wins.
      expect(shortcut?.cmds).toEqual([
        `pnpm exec tsx src/cli.ts archive {{.CLI_ARGS}} --engine ${name}`,
      ]);
    }
  });
});

describe("archive media credentials", () => {
  it("keeps configured credentials on their origin and scopes browser cookies per destination", async () => {
    const engine = {
      name: "cdp" as const,
      scrape: async () => ({}),
      downloadHeaders: async (url: string) => ({ Cookie: `session=${new URL(url).hostname}` }),
    };
    const headers = mediaHeaders(
      engine,
      { Cookie: "manual=secret", Authorization: "Bearer secret", "X-Private": "secret" },
      "https://example.com/article",
      "https://example.com/article?token=private",
    );
    const local = new Headers(await headers("https://example.com/image.png"));
    expect(local.get("cookie")).toBe("manual=secret");
    const external = new Headers(await headers("https://cdn.example.com/image.png"));
    expect(external.get("cookie")).toBe("session=cdn.example.com");
    expect(external.has("authorization")).toBe(false);
    expect(external.has("x-private")).toBe(false);
    expect(external.get("referer")).toBe("https://example.com/");
  });
});
