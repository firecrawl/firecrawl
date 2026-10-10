import { describe, test, expect, afterEach } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpClient } from "../../../v2/utils/httpClient";

describe("v2 utils: HttpClient", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    await new Promise<void>(resolve =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
  });

  async function start(status: number) {
    const state = { hits: 0 };
    server = http.createServer((_req, res) => {
      state.hits += 1;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { state, apiUrl: `http://127.0.0.1:${port}` };
  }

  test("maxRetries 0 still sends the request once", async () => {
    const { state, apiUrl } = await start(200);
    const client = new HttpClient({ apiKey: "fc-test", apiUrl, maxRetries: 0 });
    const res = await client.get("/v2/anything");
    expect(res.status).toBe(200);
    expect(state.hits).toBe(1);
  });

  test("maxRetries 1 does not retry a 502", async () => {
    const { state, apiUrl } = await start(502);
    const client = new HttpClient({
      apiKey: "fc-test",
      apiUrl,
      maxRetries: 1,
      backoffFactor: 0,
    });
    await expect(client.get("/v2/anything")).rejects.toMatchObject({
      response: { status: 502 },
    });
    expect(state.hits).toBe(1);
  });
});
