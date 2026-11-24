import { describe, test, expect, vi, afterEach } from "vitest";
import axios, { type AxiosAdapter } from "axios";
import { HttpClient } from "../../../v2/utils/httpClient";
import { Watcher } from "../../../v2/watcher";

const API_URL = "https://api.firecrawl.dev";
const JOB_ID = "job-watcher-404";

type Reply = { status: number; data: unknown };

function makeHttp(route: () => Reply) {
  const http = new HttpClient({ apiKey: "fc-test", apiUrl: API_URL, maxRetries: 1 });
  let calls = 0;
  const adapter: AxiosAdapter = async (config) => {
    calls += 1;
    const { status, data } = route();
    const response = { data, status, statusText: String(status), headers: {}, config };
    const validate = config.validateStatus;
    if (validate && !validate(status)) {
      throw new axios.AxiosError(
        `Request failed with status code ${status}`,
        undefined,
        config,
        null,
        response,
      );
    }
    return response;
  };
  (http as any).instance.defaults.adapter = adapter;
  return { http, getCalls: () => calls };
}

describe("v2 Watcher polling error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("stops polling and emits error immediately on non-retryable 4xx status (404)", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const { http, getCalls } = makeHttp(() => ({
      status: 404,
      data: { error: "Crawl job not found" },
    }));

    const watcher = new Watcher(http, JOB_ID, { kind: "crawl", pollInterval: 1 });
    const errors: any[] = [];
    watcher.on("error", (ev) => errors.push(ev));

    await watcher.start();

    expect(getCalls()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: "failed",
      id: JOB_ID,
      error: "Crawl job not found",
    });
  });

  test("stops polling and emits error immediately on non-retryable 401 for batch watcher", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const { http, getCalls } = makeHttp(() => ({
      status: 401,
      data: { error: "Invalid API key" },
    }));

    const watcher = new Watcher(http, JOB_ID, { kind: "batch", pollInterval: 1 });
    const errors: any[] = [];
    watcher.on("error", (ev) => errors.push(ev));

    await watcher.start();

    expect(getCalls()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: "failed",
      id: JOB_ID,
      error: "Invalid API key",
    });
  });

  test("keeps polling past transient 503 errors until job completes", async () => {
    vi.stubGlobal("WebSocket", undefined);
    let attempt = 0;
    const { http, getCalls } = makeHttp(() => {
      attempt += 1;
      if (attempt === 1) {
        return { status: 503, data: { error: "Service temporarily unavailable" } };
      }
      return {
        status: 200,
        data: {
          success: true,
          status: "completed",
          completed: 1,
          total: 1,
          data: [{ markdown: "hello", metadata: { sourceURL: "https://example.com" } }],
        },
      };
    });

    const watcher = new Watcher(http, JOB_ID, { kind: "crawl", pollInterval: 0.01 });
    const errors: any[] = [];
    const doneEvents: any[] = [];
    watcher.on("error", (ev) => errors.push(ev));
    watcher.on("done", (ev) => doneEvents.push(ev));

    await watcher.start();

    expect(getCalls()).toBe(2);
    expect(errors).toHaveLength(0);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ status: "completed", id: JOB_ID });
  });
});
