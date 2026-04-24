import { describe, test, expect, jest } from "@jest/globals";
import { HttpClient } from "../../../v2/utils/httpClient";

function buildClientWithSpy() {
  const client = new HttpClient({
    apiKey: "test-key",
    apiUrl: "https://api.firecrawl.dev",
  });
  const request = jest.fn(async (cfg: any) => ({
    status: 200,
    data: {},
    config: cfg,
  }));
  // Replace the internal axios instance with a spy so we can inspect
  // the config that would be sent on the wire.
  (client as any).instance = { request };
  return { client, request };
}

describe("HttpClient body-timeout override", () => {
  test("preserves ms-based timeout for /v2/scrape (adds 5s buffer)", async () => {
    const { client, request } = buildClientWithSpy();
    await client.post("/v2/scrape", { timeout: 30000 });
    const cfg = (request.mock.calls[0] as any[])[0];
    expect(cfg.timeout).toBe(35000);
  });

  test("preserves ms-based timeout for /v2/map (adds 5s buffer)", async () => {
    const { client, request } = buildClientWithSpy();
    await client.post("/v2/map", { timeout: 60000 });
    const cfg = (request.mock.calls[0] as any[])[0];
    expect(cfg.timeout).toBe(65000);
  });

  test("converts seconds to ms for /v2/scrape/:id/interact (API cap 300s)", async () => {
    const { client, request } = buildClientWithSpy();
    await client.post("/v2/scrape/job-123/interact", { timeout: 150 });
    const cfg = (request.mock.calls[0] as any[])[0];
    // Without the conversion this would have been 5150 ms and the Axios
    // client would give up long before the 150-second API call returned.
    expect(cfg.timeout).toBe(155000);
  });

  test("converts seconds to ms for /v2/browser/:id/execute (API cap 300s)", async () => {
    const { client, request } = buildClientWithSpy();
    await client.post("/v2/browser/sess-abc/execute", { timeout: 300 });
    const cfg = (request.mock.calls[0] as any[])[0];
    expect(cfg.timeout).toBe(305000);
  });

  test("does not set cfg.timeout when body has no numeric timeout", async () => {
    const { client, request } = buildClientWithSpy();
    await client.post("/v2/scrape", { formats: ["markdown"] });
    const cfg = (request.mock.calls[0] as any[])[0];
    expect(cfg.timeout).toBeUndefined();
  });

  test("seconds-conversion does not match unrelated URLs containing 'interact'", async () => {
    const { client, request } = buildClientWithSpy();
    // e.g. a future /v2/scrape endpoint taking a body with a `timeout` (ms)
    // that happens to have the word 'interact' nowhere near the URL should
    // keep ms semantics.
    await client.post("/v2/scrape", { timeout: 30000, prompt: "interact with page" });
    const cfg = (request.mock.calls[0] as any[])[0];
    expect(cfg.timeout).toBe(35000);
  });
});
