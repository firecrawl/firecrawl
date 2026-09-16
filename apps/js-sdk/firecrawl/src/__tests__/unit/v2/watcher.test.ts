import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { Watcher } from "../../../v2/watcher";
import type { HttpClient } from "../../../v2/utils/httpClient";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  close = jest.fn(() => this.onclose?.());

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  message(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
}

describe("v2 watcher deadline", () => {
  const originalWebSocket = globalThis.WebSocket;
  let watcher: Watcher;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    watcher?.close();
    jest.clearAllTimers();
    jest.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  async function start(kind: "crawl" | "batch" = "crawl", timeout: number | null = 5) {
    const get = jest.fn(async () => ({
      status: 200,
      data: { success: true, status: "scraping", completed: 0, total: 1, data: [] },
    }));
    const http = {
      getApiUrl: () => "https://example.test",
      getApiKey: () => "synthetic-key",
      get,
    } as unknown as HttpClient;
    watcher = new Watcher(http, "synthetic-job", { kind, timeout: timeout ?? undefined, pollInterval: 1 });
    const error = jest.fn();
    const done = jest.fn();
    const document = jest.fn();
    const settled = jest.fn();
    watcher.on("error", error);
    watcher.on("done", done);
    watcher.on("document", document);
    const completion = watcher.start().then(settled);
    await jest.advanceTimersByTimeAsync(0);
    return { ws: FakeWebSocket.instances[0]!, get, error, done, document, settled, completion };
  }

  test.each(["crawl", "batch"] as const)("%s times out even when the socket sends nothing", async (kind) => {
    const run = await start(kind);
    await jest.advanceTimersByTimeAsync(4999);
    expect(run.error).not.toHaveBeenCalled();
    expect(run.settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(run.error).toHaveBeenCalledWith(expect.objectContaining({ error: "Watcher timeout", id: "synthetic-job" }));
    expect(run.error).toHaveBeenCalledTimes(1);
    expect(run.ws.close).toHaveBeenCalledTimes(1);
    await run.completion;
    expect(run.settled).toHaveBeenCalledTimes(1);
    expect(run.get).not.toHaveBeenCalled();
  });

  test("document traffic does not extend the deadline", async () => {
    const run = await start();
    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(1000);
      run.ws.message({ type: "document", data: { markdown: `page ${i}` } });
    }
    expect(run.document).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(1000);
    expect(run.error).toHaveBeenCalledTimes(1);
    await run.completion;
  });

  test("WebSocket-to-polling fallback keeps the original deadline", async () => {
    const run = await start();
    await jest.advanceTimersByTimeAsync(3000);
    run.ws.onclose?.();
    await jest.advanceTimersByTimeAsync(1999);
    expect(run.get).toHaveBeenCalled();
    expect(run.error).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(run.error).toHaveBeenCalledTimes(1);
    await run.completion;
  });

  test("a pending poll cannot delay timeout or emit late completion", async () => {
    const run = await start();
    let finishPoll!: (value: any) => void;
    run.get.mockImplementation(() => new Promise(resolve => { finishPoll = resolve; }));
    run.ws.onclose?.();
    await jest.advanceTimersByTimeAsync(5000);
    expect(run.error).toHaveBeenCalledTimes(1);
    await run.completion;
    finishPoll({ status: 200, data: { success: true, status: "completed", data: [{ markdown: "late" }] } });
    await jest.advanceTimersByTimeAsync(0);
    expect(run.document).not.toHaveBeenCalled();
    expect(run.done).not.toHaveBeenCalled();
  });

  test.each(["done", "catchup"])("%s completion clears the deadline", async (type) => {
    const run = await start();
    run.ws.message({ type, data: { status: "completed", total: 1, completed: 1, data: [{ markdown: "ok" }] } });
    await run.completion;
    expect(run.done).toHaveBeenCalledTimes(1);
    expect(run.document).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10000);
    expect(run.error).not.toHaveBeenCalled();
  });

  test("manual close clears the deadline and ignores subsequent socket messages", async () => {
    const run = await start();
    watcher.close();
    expect(jest.getTimerCount()).toBe(0);
    run.ws.message({ type: "document", data: { markdown: "late" } });
    await jest.advanceTimersByTimeAsync(10000);
    expect(run.document).not.toHaveBeenCalled();
    expect(run.error).not.toHaveBeenCalled();
  });

  test.each([0, null])("timeout=%s keeps the watcher open until completion", async (timeout) => {
    const run = await start("crawl", timeout);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60000);
    expect(run.error).not.toHaveBeenCalled();
    expect(run.settled).not.toHaveBeenCalled();
    run.ws.message({ type: "done", data: { data: [] } });
    await run.completion;
  });
});
