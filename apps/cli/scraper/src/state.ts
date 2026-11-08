import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface State {
  completed: Set<string>;
  failed: Map<string, string>;
}

const STATE_DIR = ".scraper-state";

function stateFile(specKey: string): string {
  const hash = createHash("sha1").update(specKey).digest("hex").slice(0, 16);
  return join(process.cwd(), STATE_DIR, `${hash}.json`);
}

export async function loadState(specKey: string): Promise<State> {
  try {
    const raw = await readFile(stateFile(specKey), "utf8");
    const parsed = JSON.parse(raw) as {
      completed?: string[];
      failed?: Record<string, string>;
    };
    return {
      completed: new Set(parsed.completed ?? []),
      failed: new Map(Object.entries(parsed.failed ?? {})),
    };
  } catch {
    return { completed: new Set(), failed: new Map() };
  }
}

export async function saveState(specKey: string, state: State): Promise<void> {
  const path = stateFile(specKey);
  await mkdir(dirname(path), { recursive: true });
  const obj = {
    completed: [...state.completed],
    failed: Object.fromEntries(state.failed),
  };
  await writeFile(path, JSON.stringify(obj, null, 2));
}
