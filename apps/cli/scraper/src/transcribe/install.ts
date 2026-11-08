import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runProcess } from "../lib/run-process.js";
import { findOnPath } from "../lib/which.js";
import { DEFAULT_MODEL, WHISPER_VERSION, whisperHome, type WhisperPaths } from "./setup.js";

export const WHISPER_REPO = "https://github.com/ggml-org/whisper.cpp.git";
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`;

export type InstallStep = "source" | "configure" | "build" | "model";

export type InstallEvent =
  | { type: "step"; step: InstallStep; label: string }
  | { type: "log"; line: string }
  | { type: "download"; bytes: number; totalBytes: number | undefined };

export interface Toolchain {
  git?: string | undefined;
  cmake?: string | undefined;
  cxx?: string | undefined;
  nvcc?: string | undefined;
  /** CUDA compute capability without the dot, e.g. "86"; builds only for this GPU. */
  cudaArch?: string | undefined;
}

/** The whisper.cpp checkout: absent, at the pinned version, or something else. */
export type SourceState = "missing" | "current" | "other";

export interface InstallCommand {
  step: Exclude<InstallStep, "model">;
  label: string;
  command: string;
  args: string[];
}

function cudaArch(): string | undefined {
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=compute_cap", "--format=csv,noheader"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const cap = out.trim().split("\n")[0]?.trim() ?? "";
    return /^\d+\.\d+$/.test(cap) ? cap.replace(".", "") : undefined;
  } catch {
    return undefined;
  }
}

/** Build tools on this machine; CUDA is used when nvcc is found. */
export function findToolchain(env: NodeJS.ProcessEnv = process.env): Toolchain {
  const nvcc =
    findOnPath("nvcc", env) ??
    (existsSync("/usr/local/cuda/bin/nvcc") ? "/usr/local/cuda/bin/nvcc" : undefined);
  return {
    git: findOnPath("git", env),
    cmake: findOnPath("cmake", env),
    cxx: findOnPath("c++", env) ?? findOnPath("g++", env) ?? findOnPath("clang++", env),
    nvcc,
    cudaArch: nvcc ? cudaArch() : undefined,
  };
}

/** Missing required tools, each with how to get it. */
export function missingTools(tools: Toolchain): string[] {
  return [
    ...(tools.git ? [] : ["git (install it with your package manager)"]),
    ...(tools.cmake ? [] : ["cmake (`uv tool install cmake`, or your package manager)"]),
    ...(tools.cxx ? [] : ["a C++ compiler (e.g. `sudo apt install build-essential`)"]),
  ];
}

/** Commands that fetch whisper.cpp at the pinned version and build whisper-cli. */
export function installCommands(
  home: string,
  tools: Toolchain,
  source: SourceState,
  jobs = cpus().length,
): InstallCommand[] {
  const dir = join(home, "whisper.cpp");
  const build = join(dir, "build");
  const fetch: InstallCommand[] =
    source === "missing"
      ? [
          {
            step: "source",
            label: `Downloading whisper.cpp ${WHISPER_VERSION}`,
            command: "git",
            args: ["clone", "--depth", "1", "--branch", WHISPER_VERSION, WHISPER_REPO, dir],
          },
        ]
      : source === "other"
        ? [
            {
              step: "source",
              label: `Updating whisper.cpp to ${WHISPER_VERSION}`,
              command: "git",
              args: ["-C", dir, "fetch", "--depth", "1", "origin", "tag", WHISPER_VERSION],
            },
            {
              step: "source",
              label: `Updating whisper.cpp to ${WHISPER_VERSION}`,
              command: "git",
              args: ["-C", dir, "checkout", "--quiet", WHISPER_VERSION],
            },
          ]
        : [];
  const cuda = tools.nvcc
    ? [
        "-DGGML_CUDA=ON",
        `-DCMAKE_CUDA_COMPILER=${tools.nvcc}`,
        ...(tools.cudaArch ? [`-DCMAKE_CUDA_ARCHITECTURES=${tools.cudaArch}`] : []),
      ]
    : ["-DGGML_CUDA=OFF"];
  return [
    ...fetch,
    {
      step: "configure",
      label: tools.nvcc
        ? "Configuring a CUDA (GPU) build"
        : "Configuring a CPU build (no nvcc found)",
      command: "cmake",
      args: [
        "-S",
        dir,
        "-B",
        build,
        "-DCMAKE_BUILD_TYPE=Release",
        "-DWHISPER_BUILD_TESTS=OFF",
        ...cuda,
      ],
    },
    {
      step: "build",
      label: "Building whisper-cli",
      command: "cmake",
      args: [
        "--build",
        build,
        "--config",
        "Release",
        "--target",
        "whisper-cli",
        "-j",
        String(Math.max(1, jobs)),
      ],
    },
  ];
}

function sourceState(dir: string): SourceState {
  if (!existsSync(join(dir, ".git"))) return "missing";
  try {
    const tag = execFileSync("git", ["-C", dir, "describe", "--tags", "--exact-match"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return tag === WHISPER_VERSION ? "current" : "other";
  } catch {
    return "other";
  }
}

/**
 * Stream a URL to `dest` through a `.part` file, so an interrupted download
 * never looks finished. Progress is reported at most every 200 ms.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (bytes: number, totalBytes: number | undefined) => void,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url, signal ? { signal } : {});
  if (!response.ok || !response.body)
    throw new Error(`Download failed: ${url} returned HTTP ${response.status}`);
  const header = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(header) && header > 0 ? header : undefined;
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let bytes = 0;
  let reported = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      const now = Date.now();
      if (now - reported >= 200) {
        reported = now;
        onProgress(bytes, totalBytes);
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(part),
      signal ? { signal } : {},
    );
    if (totalBytes !== undefined && bytes !== totalBytes)
      throw new Error(`Download incomplete: got ${bytes} of ${totalBytes} bytes from ${url}`);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  onProgress(bytes, totalBytes);
  await rename(part, dest);
}

export interface InstallOptions {
  home?: string | undefined;
  onEvent?: ((event: InstallEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** Seams for tests. */
  toolchain?: Toolchain | undefined;
  run?: typeof runProcess | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Fetch and build whisper.cpp, then download the default model. Rerunning is
 * cheap: the checkout and model are reused and the build is incremental.
 */
export async function installWhisper(opts: InstallOptions = {}): Promise<WhisperPaths> {
  const home = opts.home ?? whisperHome();
  const tools = opts.toolchain ?? findToolchain();
  const missing = missingTools(tools);
  if (missing.length > 0)
    throw new Error(`Cannot build whisper.cpp; missing ${missing.join(", ")}.`);
  const run = opts.run ?? runProcess;
  const emit = opts.onEvent ?? (() => {});
  const dir = join(home, "whisper.cpp");
  await mkdir(home, { recursive: true });

  let current: InstallStep | undefined;
  // Each step depends on the previous one, so they run one after another.
  for (const cmd of installCommands(home, tools, sourceState(dir))) {
    if (cmd.step !== current) {
      current = cmd.step;
      emit({ type: "step", step: cmd.step, label: cmd.label });
    }
    // oxlint-disable-next-line no-await-in-loop
    await run(cmd.command, cmd.args, {
      signal: opts.signal,
      onLine: (line) => emit({ type: "log", line }),
    });
  }

  const model = join(home, "models", DEFAULT_MODEL);
  if (!existsSync(model)) {
    emit({ type: "step", step: "model", label: `Downloading model ${DEFAULT_MODEL}` });
    await downloadFile(
      MODEL_URL,
      model,
      (bytes, totalBytes) => emit({ type: "download", bytes, totalBytes }),
      opts.signal,
      opts.fetchImpl,
    );
  }
  return { bin: join(dir, "build/bin/whisper-cli"), model };
}
