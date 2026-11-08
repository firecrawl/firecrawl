import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Absolute path of an executable on PATH, like `which`. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}
