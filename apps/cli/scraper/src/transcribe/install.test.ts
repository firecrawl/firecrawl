import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadFile,
  installCommands,
  installWhisper,
  missingTools,
  MODEL_URL,
  WHISPER_REPO,
  type InstallEvent,
  type Toolchain,
} from "./install.js";

const tools: Toolchain = {
  git: "/usr/bin/git",
  cmake: "/usr/bin/cmake",
  cxx: "/usr/bin/c++",
  nvcc: "/usr/bin/nvcc",
  cudaArch: "86",
};

describe("installCommands", () => {
  it("clones the pinned version and builds whisper-cli for this GPU", () => {
    const cmds = installCommands("/h", tools, "missing", 8);
    expect(cmds.map((c) => c.step)).toEqual(["source", "configure", "build"]);
    expect(cmds[0]?.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "v1.9.5",
      WHISPER_REPO,
      "/h/whisper.cpp",
    ]);
    expect(cmds[1]?.args).toEqual(
      expect.arrayContaining([
        "-DGGML_CUDA=ON",
        "-DCMAKE_CUDA_COMPILER=/usr/bin/nvcc",
        "-DCMAKE_CUDA_ARCHITECTURES=86",
      ]),
    );
    expect(cmds[2]?.args).toEqual(expect.arrayContaining(["--target", "whisper-cli", "-j", "8"]));
  });

  it("builds for the CPU without nvcc and reuses a current checkout", () => {
    const cmds = installCommands("/h", { ...tools, nvcc: undefined }, "current", 4);
    expect(cmds.map((c) => c.step)).toEqual(["configure", "build"]);
    expect(cmds[0]?.args).toContain("-DGGML_CUDA=OFF");
    expect(cmds[0]?.label).toMatch(/CPU/);
  });

  it("moves an older checkout to the pinned version", () => {
    const cmds = installCommands("/h", tools, "other");
    expect(cmds.slice(0, 2).map((c) => c.args.slice(2, 4))).toEqual([
      ["fetch", "--depth"],
      ["checkout", "--quiet"],
    ]);
  });

  it("names missing tools and how to get them", () => {
    expect(missingTools(tools)).toEqual([]);
    expect(missingTools({ ...tools, cmake: undefined, cxx: undefined }).join("\n")).toMatch(
      /uv tool install cmake[\s\S]*C\+\+ compiler/,
    );
  });
});

function fakeFetch(body: string, init: { status?: number; length?: number } = {}): typeof fetch {
  return async () =>
    new Response(init.status && init.status >= 400 ? null : body, {
      status: init.status ?? 200,
      headers: { "content-length": String(init.length ?? Buffer.byteLength(body)) },
    });
}

describe("downloadFile and installWhisper", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "whisper-install-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("downloads through a .part file and reports progress", async () => {
    const dest = join(dir, "models/m.bin");
    const progress: Array<[number, number | undefined]> = [];
    await downloadFile(
      "https://x/m.bin",
      dest,
      (b, t) => progress.push([b, t]),
      undefined,
      fakeFetch("model-bytes"),
    );
    expect(await readFile(dest, "utf8")).toBe("model-bytes");
    expect(progress.at(-1)).toEqual([11, 11]);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("rejects HTTP errors and truncated downloads without leaving a file", async () => {
    const dest = join(dir, "m.bin");
    await expect(
      downloadFile("https://x/m.bin", dest, () => {}, undefined, fakeFetch("", { status: 404 })),
    ).rejects.toThrow("HTTP 404");
    await expect(
      downloadFile(
        "https://x/m.bin",
        dest,
        () => {},
        undefined,
        fakeFetch("short", { length: 99 }),
      ),
    ).rejects.toThrow(/incomplete|length/i);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("runs the build steps in order, then fetches the model", async () => {
    const ran: string[] = [];
    const events: InstallEvent[] = [];
    let fetched = "";
    const paths = await installWhisper({
      home: dir,
      toolchain: tools,
      onEvent: (e) => events.push(e),
      run: async (command, args, opts) => {
        ran.push(`${command} ${args[0]}`);
        opts?.onLine?.(`${command} output`, "stdout");
      },
      fetchImpl: async (url) => {
        fetched = String(url);
        return fakeFetch("weights")(url);
      },
    });
    expect(ran).toEqual(["git clone", "cmake -S", "cmake --build"]);
    expect(fetched).toBe(MODEL_URL);
    expect(events.filter((e) => e.type === "step").map((e) => e.step)).toEqual([
      "source",
      "configure",
      "build",
      "model",
    ]);
    expect(events).toContainEqual({ type: "log", line: "cmake output" });
    expect(paths.bin).toBe(join(dir, "whisper.cpp/build/bin/whisper-cli"));
    expect(await readFile(paths.model, "utf8")).toBe("weights");
  });

  it("refuses to start without the build tools", async () => {
    await expect(
      installWhisper({ home: dir, toolchain: { ...tools, git: undefined } }),
    ).rejects.toThrow(/missing git/);
  });
});
