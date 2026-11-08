import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "../archive/storage.js";

export interface RunSummary {
  dir: string;
  sourceUrl: string;
  startedAt: string;
  /** Downloaded audio and video files. */
  media: number;
  transcribed: number;
}

async function subdirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
}

/** Archive runs under `data/<host>/<run>/` that have audio or video, newest first. */
export async function listRuns(dataDir: string, limit = 10): Promise<RunSummary[]> {
  const hosts = await subdirs(dataDir);
  const runDirs = (await Promise.all(hosts.map((host) => subdirs(host)))).flat();
  const runs = await Promise.all(
    runDirs.map(async (dir): Promise<RunSummary | undefined> => {
      try {
        const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
        const media = manifest.assets.filter(
          (a) => a.status === "downloaded" && (a.kind === "audio" || a.kind === "video"),
        ).length;
        const transcribed = (manifest.transcripts ?? []).filter(
          (t) => t.status === "transcribed" || t.status === "skipped",
        ).length;
        return {
          dir,
          sourceUrl: manifest.sourceUrl,
          startedAt: manifest.startedAt,
          media,
          transcribed,
        };
      } catch {
        return undefined; // Not a finished archive run.
      }
    }),
  );
  return runs
    .filter((r): r is RunSummary => r !== undefined && r.media > 0)
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}
