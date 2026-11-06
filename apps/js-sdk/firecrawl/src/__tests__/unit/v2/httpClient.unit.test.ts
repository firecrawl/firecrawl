import { describe, test, expect, vi } from "vitest";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { FirecrawlClient } from "../../../v2/client";
import { HttpClient } from "../../../v2/utils/httpClient";
import { isRetryableError } from "../../../v2/utils/errorHandler";
import { HttpError, httpRequest } from "../../../utils/httpRequest";
import { SdkError } from "../../../v2/types";
import { mockFetch } from "../helpers/mockFetch";

const API_URL = "https://api.firecrawl.dev";

const caught = (promise: Promise<unknown>) => promise.then(() => undefined, (e) => e as any);

function hangUntilAborted() {
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
  );
}

describe("httpRequest", () => {
  test("parses a JSON body and lowercases response headers", async () => {
    mockFetch(() => ({ data: { ok: true }, headers: { "Retry-After": "7" } }));
    const res = await httpRequest(`${API_URL}/x`, { method: "get" });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
    expect(res.headers["retry-after"]).toBe("7");
  });

  test("keeps a non-JSON body as text and an empty body as an empty string", async () => {
    mockFetch(() => ({ data: "plain text" }));
    expect((await httpRequest(`${API_URL}/x`, { method: "get" })).data).toBe("plain text");
    mockFetch(() => ({ status: 204 }));
    expect((await httpRequest(`${API_URL}/x`, { method: "delete" })).data).toBe("");
  });

  test.each([
    [400, "ERR_BAD_REQUEST"],
    [409, "ERR_BAD_REQUEST"],
    [500, "ERR_BAD_RESPONSE"],
    [502, "ERR_BAD_RESPONSE"],
  ])("rejects %i with the response attached", async (status, code) => {
    mockFetch(() => ({ status, data: { error: "nope" } }));
    const err = await caught(httpRequest(`${API_URL}/x`, { method: "get" }));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.isHttpError).toBe(true);
    expect(err.message).toBe(`Request failed with status code ${status}`);
    expect(err.code).toBe(code);
    expect(err.response).toMatchObject({ status, data: { error: "nope" } });
  });

  test("sends JSON bodies with a content type and FormData untouched", async () => {
    const sent = mockFetch(() => ({ data: {} }));
    await httpRequest(`${API_URL}/x`, { method: "post", body: { a: 1 } });
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.txt");
    await httpRequest(`${API_URL}/x`, { method: "post", body: form });
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
    expect(sent[0]!.body).toEqual({ a: 1 });
    expect(sent[1]!.body).toBeInstanceOf(FormData);
    expect(sent[1]!.headers["content-type"]).toBeUndefined();
  });

  test("lifts the system error code from a failed fetch onto the error", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause });
    });
    const err = await caught(httpRequest(`${API_URL}/x`, { method: "get" }));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe("ECONNREFUSED");
    expect(err.message).toBe("connect ECONNREFUSED 127.0.0.1:1");
    expect(err.response).toBeUndefined();
  });

  test("reports a socket closed by the peer as ECONNRESET", async () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause });
    });
    const err = await caught(httpRequest(`${API_URL}/x`, { method: "get" }));
    expect(err.code).toBe("ECONNRESET");
    expect(err.message).toBe("other side closed");
  });

  test("sends JSON Accept and SDK User-Agent defaults that caller headers override", async () => {
    const sent = mockFetch(() => ({ data: {} }));
    await httpRequest(`${API_URL}/x`, { method: "get" });
    await httpRequest(`${API_URL}/x`, { method: "get", headers: { accept: "text/csv", "user-agent": "custom" } });
    expect(sent[0]!.headers.accept).toBe("application/json, text/plain, */*");
    expect(sent[0]!.headers["user-agent"]).toMatch(/^firecrawl-js\/\d+\.\d+\.\d+/);
    expect(sent[1]!.headers.accept).toBe("text/csv");
    expect(sent[1]!.headers["user-agent"]).toBe("custom");
  });

  test("routes requests through HTTP_PROXY", async () => {
    const origin = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ via: "proxy" }));
    });
    await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, client) => {
      tunnels.push(req.url!);
      const upstream = connect((origin.address() as AddressInfo).port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client).pipe(upstream);
      });
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    vi.stubEnv("NO_PROXY", "");
    try {
      vi.resetModules();
      const fresh = await import("../../../utils/httpRequest");
      const res = await fresh.httpRequest("http://firecrawl.test/v2/x", { method: "get" });
      expect(res.data).toEqual({ via: "proxy" });
      expect(tunnels).toEqual(["firecrawl.test:80"]);
    } finally {
      vi.unstubAllEnvs();
      proxy.closeAllConnections();
      origin.closeAllConnections();
      proxy.close();
      origin.close();
    }
  });

  test("uses ERR_NETWORK when the failure has no code", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const err = await caught(httpRequest(`${API_URL}/x`, { method: "get" }));
    expect(err.code).toBe("ERR_NETWORK");
  });

  test("aborts after timeoutMs with an ETIMEDOUT error that the retry check accepts", async () => {
    hangUntilAborted();
    const err = await caught(httpRequest(`${API_URL}/x`, { method: "get", timeoutMs: 20 }));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe("ETIMEDOUT");
    expect(err.message).toBe("timeout of 20ms exceeded");
    expect(isRetryableError(err)).toBe(true);
  });
});

describe("HttpClient", () => {
  test("maps a non-2xx response to an SdkError with status, code and message", async () => {
    mockFetch(() => ({ status: 402, data: { error: "Insufficient credits", code: "PAYMENT_REQUIRED", details: { need: 5 } } }));
    const client = new FirecrawlClient({ apiKey: "fc-test", apiUrl: API_URL });
    const err = await caught(client.getConcurrency());
    expect(err).toBeInstanceOf(SdkError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("PAYMENT_REQUIRED");
    expect(err.message).toBe("Insufficient credits");
    expect(err.details).toEqual({ need: 5 });
  });

  test("falls back to the transport code and message when the body has none", async () => {
    mockFetch(() => ({ status: 503, data: "Service Unavailable" }));
    const client = new FirecrawlClient({ apiKey: "fc-test", apiUrl: API_URL });
    const err = await caught(client.getConcurrency());
    expect(err).toBeInstanceOf(SdkError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("ERR_BAD_RESPONSE");
    expect(err.message).toBe("Request failed with status code 503");
  });

  test("a request that outlives the client timeout fails with ETIMEDOUT", async () => {
    hangUntilAborted();
    const client = new FirecrawlClient({ apiKey: "fc-test", apiUrl: API_URL, timeoutMs: 20 });
    const err = await caught(client.getConcurrency());
    expect(err).toBeInstanceOf(SdkError);
    expect(err.code).toBe("ETIMEDOUT");
    expect(err.message).toBe("timeout of 20ms exceeded");
  });

  test("a per-request timeout overrides the client timeout", async () => {
    hangUntilAborted();
    const http = new HttpClient({ apiKey: "fc-test", apiUrl: API_URL, timeoutMs: 60_000 });
    const err = await caught(http.post("/v2/scrape", {}, { timeoutMs: 20 }));
    expect(err.message).toBe("timeout of 20ms exceeded");
  });

  test("retries a 502 with backoff and returns the next response", async () => {
    let calls = 0;
    const sent = mockFetch(() => (++calls < 3 ? { status: 502, data: "bad gateway" } : { data: { success: true } }));
    const http = new HttpClient({ apiKey: "fc-test", apiUrl: API_URL, backoffFactor: 0.001 });
    const res = await http.get("/v2/concurrency-check");
    expect(res.data).toEqual({ success: true });
    expect(sent).toHaveLength(3);
  });

  test("stops retrying a 502 after maxRetries attempts and throws it", async () => {
    const sent = mockFetch(() => ({ status: 502, data: "bad gateway" }));
    const http = new HttpClient({ apiKey: "fc-test", apiUrl: API_URL, backoffFactor: 0.001, maxRetries: 2 });
    const err = await caught(http.get("/v2/concurrency-check"));
    expect(err.response.status).toBe(502);
    expect(sent).toHaveLength(2);
  });

  test("does not retry other errors", async () => {
    const sent = mockFetch(() => ({ status: 500, data: { error: "boom" } }));
    const http = new HttpClient({ apiKey: "fc-test", apiUrl: API_URL, backoffFactor: 0.001 });
    await caught(http.get("/v2/concurrency-check"));
    expect(sent).toHaveLength(1);
  });

  test("joins relative paths onto the API URL and sends the bearer token", async () => {
    const sent = mockFetch(() => ({ data: {} }));
    await new HttpClient({ apiKey: "fc-test", apiUrl: `${API_URL}/` }).get("/v2/team/credit-usage");
    expect(sent[0]!.url).toBe(`${API_URL}/v2/team/credit-usage`);
    expect(sent[0]!.headers.authorization).toBe("Bearer fc-test");
  });

  test("sends multipart bodies without a JSON content type", async () => {
    const sent = mockFetch(() => ({ data: {} }));
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.txt");
    await new HttpClient({ apiKey: "fc-test", apiUrl: API_URL }).postMultipart("/v2/parse", form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    expect(sent[0]!.body).toBeInstanceOf(FormData);
    expect(sent[0]!.headers["content-type"]).toBeUndefined();
  });
});
