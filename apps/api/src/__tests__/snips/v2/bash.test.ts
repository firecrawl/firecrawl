import { ALLOW_TEST_SUITE_WEBSITE, itIf, TEST_SUITE_WEBSITE } from "../lib";
import request, { idmux, Identity, scrapeTimeout, TEST_API_URL } from "./lib";

describe("Hosted bash", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({ name: "bash", concurrency: 10, credits: 1000 });
  }, 10000);

  const run = (command: string) =>
    request(TEST_API_URL)
      .post("/v2/bash")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .type("form")
      .send(command);

  it("serves usage", async () => {
    const res = await request(TEST_API_URL).get("/v2/bash");
    expect(res.status).toBe(200);
    expect(res.text).toContain("/v2/bash --data-binary 'firecrawl search");
  });

  it("runs a command in a fresh shell", async () => {
    const res = await run("echo hello | tr a-z A-Z; cat /README.md | head -1");
    expect(res.status).toBe(200);
    expect(res.headers["x-exit-code"]).toBe("0");
    expect(res.text).toBe("HELLO\n# Firecrawl bash\n");
  });

  itIf(ALLOW_TEST_SUITE_WEBSITE)(
    "scrapes through the API's own scrape route",
    async () => {
      const res = await run(
        `firecrawl scrape ${TEST_SUITE_WEBSITE} | grep -c Firecrawl`,
      );
      expect(res.headers["x-exit-code"]).toBe("0");
      expect(Number(res.text.trim())).toBeGreaterThan(0);
    },
    scrapeTimeout,
  );

  it("exits 2 for a command outside the hosted subset", async () => {
    const res = await run("firecrawl crawl https://example.com");
    expect(res.headers["x-exit-code"]).toBe("2");
    expect(res.text).toContain("npx -y firecrawl-cli@latest init");
  });

  it("stops a runaway command", async () => {
    const res = await run("while true; do :; done");
    expect(res.headers["x-exit-code"]).toBe("126");
  });
});
