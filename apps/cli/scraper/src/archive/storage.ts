import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScrapeResponseData } from "../formats/types.js";
import type { MediaResult } from "./download.js";

export interface PageResult {
  url: string;
  finalUrl?: string;
  title?: string;
  path: string;
  status: "saved" | "failed" | "skipped";
  reason?: string;
  warning?: string;
  files?: string[];
}

export interface Manifest {
  sourceUrl: string;
  engine: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "partial" | "interrupted";
  settings: {
    limit: number;
    maxMediaMb: number;
    delayMs: number;
    playMedia: boolean;
    media: Array<"image" | "video" | "audio">;
    transcribe?: { workers: number; language: string; model: string };
  };
  limitReached: boolean;
  pages: PageResult[];
  assets: MediaResult[];
  /** Present when transcription was enabled. */
  transcripts?: TranscriptEntry[];
}

export interface TranscriptEntry {
  /** Source media URL. */
  asset: string;
  /** Downloaded media path, relative to the archive root. */
  media: string;
  status: "queued" | "transcribed" | "skipped" | "failed";
  /** Transcript files relative to the archive root: .srt, .vtt, .json, .txt. */
  files?: string[] | undefined;
  language?: string | undefined;
  durationSec?: number | undefined;
  segments?: number | undefined;
  reason?: string | undefined;
}

async function jsonFile(path: string, data: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

export async function savePage(
  root: string,
  result: PageResult,
  data: ScrapeResponseData,
  links: string[],
  media: MediaResult[],
): Promise<void> {
  const dir = join(root, result.path);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  result.files = files;
  await Promise.all(
    (
      [
        ["markdown", "content.md"],
        ["html", "page.html"],
        ["rawHtml", "raw.html"],
      ] as const
    ).map(async ([key, name]) => {
      if (typeof data[key] === "string") {
        await writeFile(join(dir, name), data[key]);
        files.push(name);
      }
    }),
  );
  files.sort();
  if (data.screenshot?.startsWith("data:image/png;base64,")) {
    await writeFile(
      join(dir, "screenshot.png"),
      Buffer.from(data.screenshot.split(",")[1] ?? "", "base64"),
    );
    files.push("screenshot.png");
  }
  await jsonFile(join(dir, "page.json"), {
    ...result,
    metadata: data.metadata ?? {},
    links,
    media,
  });
}

function mdText(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
}

export async function saveManifest(root: string, manifest: Manifest): Promise<void> {
  await jsonFile(join(root, "manifest.json"), manifest);
  const failed =
    manifest.pages.filter((p) => p.status === "failed").length +
    manifest.assets.filter((a) => a.status === "failed").length;
  const lines = [
    `# ${mdText(new URL(manifest.sourceUrl).host)}`,
    "",
    `Source: ${mdText(manifest.sourceUrl)}`,
    "",
    `Engine: **${manifest.engine}** · Status: **${manifest.status}**`,
    "",
    `${manifest.pages.filter((p) => p.status === "saved").length} pages saved · ${manifest.assets.filter((a) => a.status === "downloaded").length} assets downloaded · ${failed} failures`,
    "",
    manifest.limitReached
      ? "Page limit reached; additional discovered pages were not visited."
      : "",
    "",
    "## Pages",
    "",
  ];
  for (const page of manifest.pages) {
    const label = mdText(page.title || page.url);
    const details = encodeURI(`${page.path}/page.json`);
    lines.push(
      `- [${label}](${details}) — ${page.status}${page.reason ? `: ${mdText(page.reason)}` : ""}`,
    );
    for (const [name, fileLabel] of [
      ["content.md", "Markdown"],
      ["raw.html", "HTML"],
      ["screenshot.png", "Screenshot"],
    ]) {
      if (name && page.files?.includes(name))
        lines.push(`  · [${fileLabel}](${encodeURI(`${page.path}/${name}`)})`);
    }
    if (page.warning) lines.push(`  · ${mdText(page.warning)}`);
  }
  lines.push("", "## Media", "");
  for (const asset of manifest.assets)
    lines.push(
      asset.path
        ? `- [${mdText(new URL(asset.url).pathname)}](${encodeURI(asset.path)}) — ${asset.bytes ?? 0} bytes`
        : `- ${mdText(asset.url)} — ${asset.status}: ${mdText(asset.reason ?? "")}`,
    );
  if (manifest.transcripts) {
    lines.push("", "## Transcripts", "");
    for (const t of manifest.transcripts) {
      const txt = t.files?.find((file) => file.endsWith(".txt"));
      lines.push(
        txt && t.status !== "failed"
          ? `- [${mdText(t.media)}](${encodeURI(txt)}) — ${t.segments ?? "?"} segments, ${t.durationSec ?? "?"}s` +
              (t.files ?? [])
                .filter((file) => !file.endsWith(".txt"))
                .map(
                  (file) =>
                    ` · [${file.slice(file.lastIndexOf(".") + 1).toUpperCase()}](${encodeURI(file)})`,
                )
                .join("")
          : `- ${mdText(t.media)} — ${t.status}${t.reason ? `: ${mdText(t.reason)}` : ""}`,
      );
    }
  }
  await writeFile(join(root, "index.md"), `${lines.join("\n")}\n`);
}
