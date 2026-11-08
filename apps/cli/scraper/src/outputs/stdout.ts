import type { OutputWriter } from "./types.js";

export class StdoutWriter implements OutputWriter {
  readonly isStdout = true;

  async open(): Promise<void> {}

  async write(_url: string, content: string | Buffer): Promise<void> {
    if (Buffer.isBuffer(content)) {
      process.stdout.write(content);
    } else {
      process.stdout.write(content);
      if (!content.endsWith("\n")) process.stdout.write("\n");
    }
  }

  async close(): Promise<void> {}
}
