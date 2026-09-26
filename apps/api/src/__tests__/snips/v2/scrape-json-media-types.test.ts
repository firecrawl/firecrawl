import http from "node:http";
import { describeIf, HAS_PROXY, TEST_PRODUCTION } from "../lib";
import { Identity, idmux, scrape, scrapeTimeout } from "./lib";

describeIf(!TEST_PRODUCTION && !HAS_PROXY)("JSON media types", () => {
  const payload = { data: [{ full_name: "a_b", tags: ["c_d"] }] };
  let server: http.Server;
  let base: string;
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-json-media-types",
      concurrency: 10,
      credits: 1000,
    });
    server = http.createServer((req, res) => {
      if (req.url === "/html") {
        res.setHeader("Content-Type", 'text/html; profile="application/json"');
        res.end(
          "<html><body><p>Hello <strong>world</strong></p></body></html>",
        );
      } else {
        res.setHeader(
          "Content-Type",
          "application/vnd.api+json; charset=utf-8",
        );
        res.end(JSON.stringify(payload));
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start JSON fixture");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  it(
    "preserves vendor JSON without Markdown escaping",
    async () => {
      const response = await scrape(
        { url: `${base}/json`, formats: ["markdown"], maxAge: 0 },
        identity,
      );
      expect(response.markdown).toBe(
        "```json\n" + JSON.stringify(payload) + "\n```",
      );
    },
    scrapeTimeout,
  );

  it(
    "still converts HTML with a JSON media type in a parameter",
    async () => {
      const response = await scrape(
        { url: `${base}/html`, formats: ["markdown"], maxAge: 0 },
        identity,
      );
      expect(response.markdown).toContain("Hello **world**");
      expect(response.markdown).not.toContain("```json");
    },
    scrapeTimeout,
  );
});
