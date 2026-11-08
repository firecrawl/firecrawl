import { readFile } from "node:fs/promises";
import type { InputSource } from "./types.js";

export class FileInput implements InputSource {
  constructor(private readonly path: string) {}

  async *read(): AsyncIterable<string> {
    const raw = await readFile(this.path, "utf8");
    if (this.path.endsWith(".json")) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`${this.path}: expected JSON array of URLs`);
      }
      for (const u of parsed) {
        if (typeof u !== "string") {
          throw new Error(`${this.path}: non-string entry in array`);
        }
        yield u;
      }
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      yield trimmed;
    }
  }
}
