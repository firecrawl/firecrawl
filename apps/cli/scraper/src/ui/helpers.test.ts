import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCdp, chromeLaunch } from "./chrome.js";
import { listRuns } from "./runs.js";

let dir = "";

async function refused(): Promise<Response> {
  throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ui-helpers-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkCdp", () => {
  it("reports the browser behind a DevTools endpoint", async () => {
    let asked = "";
    const result = await checkCdp("http://localhost:9222", async (url) => {
      asked = String(url);
      return Response.json({ Browser: "Chrome/141.0" });
    });
    expect(asked).toBe("http://localhost:9222/json/version");
    expect(result).toEqual({ ok: true, browser: "Chrome/141.0" });
  });

  it("explains why nothing answered", async () => {
    expect(await checkCdp("http://localhost:9222", refused)).toEqual({
      ok: false,
      error: "connect ECONNREFUSED",
    });
    expect(
      await checkCdp("http://localhost:9222", async () => new Response("", { status: 404 })),
    ).toEqual({ ok: false, error: "HTTP 404" });
  });
});

describe("chromeLaunch", () => {
  it("starts a Chrome found on PATH with the dedicated profile and the URL's port", async () => {
    const chrome = join(dir, "google-chrome");
    await writeFile(chrome, "#!/bin/sh\n");
    await chmod(chrome, 0o755);
    const launch = chromeLaunch("http://127.0.0.1:9333", "linux", { PATH: dir });
    expect(launch?.command).toBe(chrome);
    expect(launch?.args).toContain("--remote-debugging-port=9333");
    expect(
      launch?.args.some((a) => a.startsWith("--user-data-dir=") && a.endsWith(".scraper-chrome")),
    ).toBe(true);
  });

  it("refuses remote URLs and machines without Chrome", () => {
    expect(chromeLaunch("http://10.0.0.5:9222", "linux", { PATH: dir })).toBeUndefined();
    expect(chromeLaunch("http://localhost:9222", "linux", { PATH: dir })).toBeUndefined();
  });
});

describe("listRuns", () => {
  async function run(host: string, name: string, startedAt: string, kinds: string[]) {
    const runDir = join(dir, host, name);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "manifest.json"),
      JSON.stringify({
        sourceUrl: `https://${host}/`,
        startedAt,
        assets: kinds.map((kind, i) => ({
          url: `u${i}`,
          kind,
          status: "downloaded",
          path: `p${i}`,
        })),
        transcripts: [{ status: "transcribed" }],
      }),
    );
  }

  it("lists runs with audio or video, newest first", async () => {
    await run("a.test", "old", "2026-11-01T00:00:00Z", ["audio"]);
    await run("b.test", "new", "2026-11-07T00:00:00Z", ["video", "audio", "image"]);
    await run("c.test", "images", "2026-11-08T00:00:00Z", ["image"]);
    await mkdir(join(dir, "c.test", "unfinished"));

    const runs = await listRuns(dir);
    expect(runs.map((r) => [r.dir, r.media, r.transcribed])).toEqual([
      [join(dir, "b.test/new"), 2, 1],
      [join(dir, "a.test/old"), 1, 1],
    ]);
    expect(await listRuns(join(dir, "missing"))).toEqual([]);
  });
});
