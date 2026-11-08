import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { OutputWriter } from "./types.js";

export class FileWriter implements OutputWriter {
  readonly isStdout = false;
  private handle: FileHandle | null = null;
  private wroteAny = false;

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.handle = await open(this.path, "w");
  }

  async write(_url: string, content: string | Buffer, _ext: string): Promise<void> {
    if (!this.handle) throw new Error("FileWriter not opened");
    if (this.wroteAny) await this.handle.write("\n");
    if (Buffer.isBuffer(content)) {
      await this.handle.write(content);
    } else {
      await this.handle.write(content);
      if (!content.endsWith("\n")) await this.handle.write("\n");
    }
    this.wroteAny = true;
  }

  async close(): Promise<void> {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = null;
  }
}
