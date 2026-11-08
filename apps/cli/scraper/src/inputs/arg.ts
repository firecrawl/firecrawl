import type { InputSource } from "./types.js";

export class ArgInput implements InputSource {
  constructor(private readonly urls: readonly string[]) {}

  async *read(): AsyncIterable<string> {
    for (const url of this.urls) yield url;
  }
}
