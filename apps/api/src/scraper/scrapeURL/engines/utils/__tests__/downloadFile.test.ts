import { ReadableStream } from "node:stream/web";
import {
  checkContentLength,
  createSizeLimiter,
  DownloadSizeLimitError,
} from "../downloadFile";

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

describe("download size limits", () => {
  it("records the declared size when Content-Length exceeds the limit", () => {
    const response = {
      headers: new Headers({ "content-length": "104857600" }),
    };

    expect(() => checkContentLength(response, 52428800)).toThrowError(
      expect.objectContaining({
        max_size_bytes: 52428800,
        size_source: "content_length",
        declared_size_bytes: 104857600,
      }),
    );
  });

  it("records bytes received when a stream exceeds the limit", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    });

    await expect(
      readStream(source.pipeThrough(createSizeLimiter(5))),
    ).rejects.toMatchObject({
      max_size_bytes: 5,
      size_source: "stream",
      observed_size_bytes: 8,
    } satisfies Partial<DownloadSizeLimitError>);
  });

  it("allows a stream whose size equals the limit", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    });

    const chunks = await readStream(source.pipeThrough(createSizeLimiter(5)));

    expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      5,
    );
  });
});
