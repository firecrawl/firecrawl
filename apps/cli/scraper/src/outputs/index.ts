import { stat } from "node:fs/promises";
import { DirWriter } from "./dir.js";
import { FileWriter } from "./file.js";
import { StdoutWriter } from "./stdout.js";
import type { OutputWriter } from "./types.js";

export async function pickOutput(spec: string | undefined): Promise<OutputWriter> {
  if (!spec || spec === "-") return new StdoutWriter();
  if (spec.endsWith("/") || spec.endsWith("\\")) return new DirWriter(spec);
  try {
    const s = await stat(spec);
    if (s.isDirectory()) return new DirWriter(spec);
  } catch {
    // doesn't exist yet — infer from path: extension → file, no extension → dir
  }
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(spec);
  return hasExt ? new FileWriter(spec) : new DirWriter(spec);
}

export type { OutputWriter };
