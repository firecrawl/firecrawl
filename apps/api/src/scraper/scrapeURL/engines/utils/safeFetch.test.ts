import { createServer, type Server } from "node:http";
import { config } from "../../../../config";
import undici from "undici";
import { getSecureDispatcher, getSecureDispatcherNoCookies } from "./safeFetch";

describe("private target permissions", () => {
  let server: Server;
  let localUrl: string;
  const originalScraping = config.ALLOW_PRIVATE_IP_SCRAPING;
  const originalWebhooks = config.ALLOW_LOCAL_WEBHOOKS;

  beforeEach(async () => {
    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local TCP listener");
    }
    localUrl = `http://127.0.0.1:${address.port}/`;
    config.ALLOW_PRIVATE_IP_SCRAPING = false;
    config.ALLOW_LOCAL_WEBHOOKS = false;
  });

  afterEach(async () => {
    config.ALLOW_PRIVATE_IP_SCRAPING = originalScraping;
    config.ALLOW_LOCAL_WEBHOOKS = originalWebhooks;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it("blocks private scrape targets by default", async () => {
    await expect(
      undici.fetch(localUrl, { dispatcher: getSecureDispatcher() }),
    ).rejects.toThrow();
  });

  it("allows private scraping without allowing private webhook destinations", async () => {
    config.ALLOW_PRIVATE_IP_SCRAPING = true;
    const scrape = await undici.fetch(localUrl, {
      dispatcher: getSecureDispatcher(),
    });
    expect(scrape.status).toBe(200);

    await expect(
      undici.fetch(localUrl, { dispatcher: getSecureDispatcherNoCookies() }),
    ).rejects.toThrow();
  });

  it("preserves the legacy local webhook permission", async () => {
    config.ALLOW_LOCAL_WEBHOOKS = true;
    const webhook = await undici.fetch(localUrl, {
      dispatcher: getSecureDispatcherNoCookies(),
    });
    expect(webhook.status).toBe(200);
  });
});
