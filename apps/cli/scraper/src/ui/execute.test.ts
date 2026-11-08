import { describe, expect, it, vi } from "vitest";
import type { ArchiveOptions } from "../commands/archive.js";
import type { Config } from "../config.js";
import { executePlan, storeFor, type ExecuteDeps } from "./execute.js";
import type { ArchiveRunPlan, TranscribeRunPlan } from "./wizard.js";

const config = { transcribe: { whisperBin: "/w/whisper-cli", model: "/w/model.bin" } } as Config;

const archivePlan: ArchiveRunPlan = {
  kind: "archive",
  url: "https://example.com/",
  engine: "cdp",
  cdpUrl: "http://localhost:9222",
  playMedia: false,
  limit: 5,
  delayMs: 0,
  media: ["audio"],
  maxMediaMb: 10,
  transcribe: { workers: 2, language: "en", model: undefined, cpu: false },
  out: "/data",
  setupFirst: true,
};

function fakes(status: "completed" | "partial" | "interrupted" = "completed") {
  const calls: string[] = [];
  let archiveOptions: ArchiveOptions | undefined;
  const deps: ExecuteDeps = {
    install: vi.fn(async () => {
      calls.push("install");
      return { bin: "/w/whisper-cli", model: "/w/model.bin" };
    }),
    archive: vi.fn(async (opts: ArchiveOptions) => {
      calls.push("archive");
      archiveOptions = opts;
      return { root: "/data/run", manifest: { status } } as Awaited<
        ReturnType<ExecuteDeps["archive"]>
      >;
    }),
    transcribe: vi.fn(async () => {
      calls.push("transcribe");
      return [
        { input: "a", status: "transcribed" as const },
        { input: "b", status: "failed" as const, reason: "boom" },
      ];
    }),
  };
  return { deps, calls, archiveOptions: () => archiveOptions };
}

describe("executePlan", () => {
  it("installs whisper first, then archives with the chosen options", async () => {
    const { deps, calls, archiveOptions } = fakes();
    const store = storeFor(archivePlan);
    const code = await executePlan(archivePlan, config, store, new AbortController().signal, deps);

    expect(code).toBe(0);
    expect(calls).toEqual(["install", "archive"]);
    const opts = archiveOptions()!;
    expect(opts).toMatchObject({
      url: "https://example.com/",
      engineName: "cdp",
      cdpUrlOverride: "http://localhost:9222",
      out: "/data",
      limit: 5,
      media: ["audio"],
    });
    expect(opts.transcribe?.workers).toBe(2);
    expect(opts.transcribe?.settings).toMatchObject({
      language: "en",
      gpu: true,
      whisper: { bin: "/w/whisper-cli", model: "/w/model.bin" },
    });
    expect(opts.reporter).toBeDefined();
    expect(store.getSnapshot().workers).toHaveLength(2);
  });

  it("maps archive status to the exit code", async () => {
    const plan = { ...archivePlan, setupFirst: false };
    const codes = await Promise.all(
      (["partial", "interrupted"] as const).map((status) =>
        executePlan(plan, config, storeFor(plan), new AbortController().signal, fakes(status).deps),
      ),
    );
    expect(codes).toEqual([1, 130]);
  });

  it("reports transcription results and fails when any file failed", async () => {
    const plan: TranscribeRunPlan = {
      kind: "transcribe",
      inputs: ["/data/run"],
      choices: { workers: 1, language: "auto", model: undefined, cpu: false },
      setupFirst: false,
    };
    const { deps, calls } = fakes();
    const store = storeFor(plan);
    expect(await executePlan(plan, config, store, new AbortController().signal, deps)).toBe(1);
    expect(calls).toEqual(["transcribe"]);
    expect(store.getSnapshot().done).toMatchObject({ status: "partial" });
    expect(store.getSnapshot().done?.detail).toContain("1 transcribed, 0 skipped, 1 failed");
  });

  it("shows a failure instead of throwing", async () => {
    const { deps } = fakes();
    deps.install = vi.fn(async () => {
      throw new Error("Cannot build whisper.cpp; missing cmake");
    });
    const store = storeFor({ kind: "setup" });
    expect(
      await executePlan({ kind: "setup" }, config, store, new AbortController().signal, deps),
    ).toBe(1);
    expect(store.getSnapshot().done).toEqual({
      status: "failed",
      detail: "Cannot build whisper.cpp; missing cmake",
    });
  });
});
