import http from "http";
import type { AddressInfo } from "net";
import * as undici from "undici";

// The security check in safeFetch destroys sockets to private IPs unless
// ALLOW_LOCAL_WEBHOOKS is set; the test server below listens on loopback.
vi.mock("../../../../config", () => ({
  config: {
    ALLOW_LOCAL_WEBHOOKS: true,
    PROXY_SERVER: undefined,
    PROXY_USERNAME: undefined,
    PROXY_PASSWORD: undefined,
  },
}));

import { getSecureDispatcher } from "./safeFetch";

describe("getSecureDispatcher cookie isolation", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/set") {
        res.setHeader("Set-Cookie", "session=user-a-token; Path=/");
        res.end("set");
        return;
      }
      res.end(req.headers.cookie ?? "");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("does not leak cookies between separately obtained dispatchers", async () => {
    // "User A" scrapes a page that sets a cookie.
    await undici.fetch(`${baseUrl}/set`, {
      dispatcher: getSecureDispatcher(),
    });

    // "User B" scrapes the same origin with a freshly obtained dispatcher.
    const res = await undici.fetch(`${baseUrl}/read`, {
      dispatcher: getSecureDispatcher(),
    });

    expect(await res.text()).toBe("");
  });

  it("keeps cookies within a single dispatcher instance", async () => {
    const dispatcher = getSecureDispatcher();

    await undici.fetch(`${baseUrl}/set`, { dispatcher });
    const res = await undici.fetch(`${baseUrl}/read`, { dispatcher });

    expect(await res.text()).toBe("session=user-a-token");
  });
});
