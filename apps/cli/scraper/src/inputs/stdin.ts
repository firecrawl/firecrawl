import type { InputSource } from "./types.js";

export class StdinInput implements InputSource {
  async *read(): AsyncIterable<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      yield trimmed;
    }
  }
}
