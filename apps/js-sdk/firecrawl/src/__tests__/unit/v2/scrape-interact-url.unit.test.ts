import { createServer, type Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { Firecrawl } from "../../../index";

describe("scrape interaction fallback URL", () => {
  let server: Server;
  let client: Firecrawl;
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    body: Record<string, unknown>;
  }> = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ method: req.method, path: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v2/scrape/missing-context/interact" && !body.url) {
        res.statusCode = 409;
        res.end(
          JSON.stringify({
            success: false,
            error: "Replay context is unavailable. Supply url to continue.",
          }),
        );
        return;
      }
      res.end(JSON.stringify({ success: true, stdout: "ok", exitCode: 0 }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    client = new Firecrawl({
      apiKey: "fc-test",
      apiUrl: `http://127.0.0.1:${port}`,
      origin: "js-sdk.test",
    });
  });

  beforeEach(() => {
    requests.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  for (const method of ["interact", "scrapeExecute"] as const) {
    test.each([
      { code: "console.log(await page.url())" },
      { prompt: "Read the page title" },
    ])(`${method} forwards the fallback URL with %j`, async (execution) => {
      const url = "https://example.com/path?next=%2Fpricing&lang=en#details";
      const result = await client[method]("missing-context", {
        ...execution,
        url,
        language: "node",
        timeout: 60,
      });

      expect(result).toEqual({ success: true, stdout: "ok", exitCode: 0 });
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/v2/scrape/missing-context/interact",
          body: {
            ...execution,
            url,
            language: "node",
            timeout: 60,
            origin: "js-sdk.test",
          },
        },
      ]);
    });

    test(`${method} omits the fallback URL when not supplied`, async () => {
      await client[method]("retained-context", {
        prompt: "Read the page title",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toEqual({
        prompt: "Read the page title",
        language: "node",
        origin: "js-sdk.test",
      });
    });

    test(`${method} preserves a missing-context error without a URL`, async () => {
      await expect(
        client[method]("missing-context", {
          code: "console.log(await page.url())",
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Replay context is unavailable"),
      });
      expect(requests).toHaveLength(1);
    });
  }
});
