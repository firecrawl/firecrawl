import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import { registerHostedBashRoute } from "../bash";

const DOCS_INDEX = `# Firecrawl Docs
- [Intro](https://docs.firecrawl.dev/introduction.md): Start here.
- [CLI](https://docs.firecrawl.dev/sdks/cli.md): The CLI.
`;

interface InnerCall {
  path: string;
  ip: string | undefined;
  authorization: string | undefined;
  body: any;
}

/**
 * The route under test plus stand-ins for /v2/search and /v2/scrape on the same
 * server, since the shell calls back into the server that answered it.
 */
describe("hosted bash route", () => {
  const realFetch = globalThis.fetch;
  const calls: InnerCall[] = [];
  let respond: (call: InnerCall) => { status: number; json: unknown };
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    // One trusted hop, like the load balancer in front of the real API.
    app.set("trust proxy", 1);
    registerHostedBashRoute(app);
    app.use(express.json());
    app.post(["/v2/search", "/v2/scrape"], (req, res) => {
      const call: InnerCall = {
        path: req.path,
        ip: req.ip,
        authorization: req.get("authorization"),
        body: req.body,
      };
      calls.push(call);
      const { status, json } = respond(call);
      res.status(status).json(json);
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The docs mount reads docs.firecrawl.dev; everything else is the real fetch.
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (!url.startsWith("https://docs.firecrawl.dev/")) {
        return realFetch(input, init);
      }
      const body = url.endsWith("/llms.txt") ? DOCS_INDEX : `page ${url}\n`;
      return Promise.resolve(new Response(body));
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    calls.length = 0;
    respond = call =>
      call.path === "/v2/scrape"
        ? {
            status: 200,
            json: {
              success: true,
              data: {
                markdown: "# Example",
                links: ["https://a.test", "https://b.test"],
                metadata: { title: "Example" },
              },
            },
          }
        : {
            status: 200,
            json: {
              success: true,
              id: "search-1",
              creditsUsed: 2,
              data: {
                web: [
                  {
                    title: "First",
                    url: "https://first.test",
                    description: "About first",
                  },
                  { url: "https://second.test", markdown: "line 1\nline 2" },
                ],
              },
            },
          };
  });

  // The caller's address as the load balancer would report it.
  const run = (command: string, ip = "203.0.113.9") =>
    request(base)
      .post("/v2/bash")
      .set("X-Forwarded-For", ip)
      .type("form")
      .send(command);

  it("serves usage that points at its own URL", async () => {
    const res = await request(base).get("/v2/bash");
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      `curl ${base}/v2/bash --data-binary 'firecrawl search`,
    );
  });

  it("runs a raw command sent the way curl --data-binary sends it", async () => {
    const res = await run("echo 'a=1&b=2' | tr a-z A-Z; ls /");
    expect(res.status).toBe(200);
    expect(res.headers["x-exit-code"]).toBe("0");
    expect(res.text).toBe("A=1&B=2\nREADME.md\nbin\ndev\ndocs\nproc\nusr\n");
  });

  it("takes a command from the query string or a JSON body, and returns JSON", async () => {
    const get = await request(base)
      .get("/v2/bash")
      .query({ command: "echo from-query" });
    expect(get.text).toBe("from-query\n");

    const post = await request(base)
      .post("/v2/bash?format=json")
      .send({ command: "echo out; echo err >&2; exit 3" });
    expect(post.body).toMatchObject({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 3,
      truncated: false,
    });
    expect(post.headers["x-exit-code"]).toBe("3");
  });

  it("mounts the docs and reads pages on demand", async () => {
    const res = await run("ls /docs /docs/sdks; cat /docs/sdks/cli.md");
    expect(res.text).toBe(
      "/docs:\nintroduction.md\nllms.txt\nsdks\n\n/docs/sdks:\ncli.md\npage https://docs.firecrawl.dev/sdks/cli.md\n",
    );
  });

  it("scrapes through the API's own route as the caller", async () => {
    const res = await run("firecrawl scrape example.com --full-page");
    expect(res.text).toBe("# Example\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/v2/scrape",
      // Auth and quotas key on this: it must be the caller, not loopback.
      ip: "203.0.113.9",
      authorization: undefined,
      body: {
        url: "https://example.com",
        formats: ["markdown"],
        onlyMainContent: false,
        origin: "bash",
        integration: "_firecrawl-bash",
      },
    });
  });

  it("gives each caller its own identity", async () => {
    await run("firecrawl scrape https://example.com", "198.51.100.1");
    await run("firecrawl scrape https://example.com", "198.51.100.2");
    expect(calls.map(call => call.ip)).toEqual([
      "198.51.100.1",
      "198.51.100.2",
    ]);
  });

  it("passes the caller's API key through", async () => {
    await run("firecrawl scrape https://example.com").set(
      "Authorization",
      "Bearer fc-test",
    );
    expect(calls[0].authorization).toBe("Bearer fc-test");
  });

  it("prints scrape formats the way the CLI does", async () => {
    const res = await run(
      [
        "firecrawl scrape https://example.com links",
        "firecrawl scrape https://example.com -f markdown,links",
        "firecrawl scrape https://example.com -o out/page.md && cat out/page.md",
      ].join("\n"),
    );
    expect(res.text).toBe(
      [
        "https://a.test\nhttps://b.test",
        '{"markdown":"# Example","links":["https://a.test","https://b.test"],"metadata":{"title":"Example"}}',
        "# Example",
      ].join("\n"),
    );
  });

  it("saves several URLs to .firecrawl/ and reports the ones that fail", async () => {
    respond = call =>
      call.body.url.includes("bad")
        ? { status: 500, json: { success: false, error: "boom" } }
        : { status: 200, json: { success: true, data: { markdown: "ok" } } };
    const res = await run(
      "firecrawl scrape https://good.test/a/b https://bad.test; ls .firecrawl",
    );
    expect(res.text).toContain("good.test-a-b.md\n");
    expect(res.text).toContain("Scraping 2 URLs...");
    expect(res.text).toContain("Saved: .firecrawl/good.test-a-b.md");
    expect(res.text).toContain("Error: https://bad.test - boom");
    expect(res.text).toContain("Completed: 1/2 succeeded, 1 failed");
    expect(res.headers["x-exit-code"]).toBe("0");
  });

  it("searches, in the CLI's readable and JSON output", async () => {
    const readable = await run('firecrawl search "two words" --limit 2');
    expect(readable.text).toBe(
      [
        "First",
        "  URL: https://first.test",
        "  About first",
        "",
        "Untitled",
        "  URL: https://second.test",
        "",
        "  --- Content ---",
        "  line 1",
        "  line 2",
        "  --- End Content ---",
        "",
      ].join("\n"),
    );
    expect(calls[0].body).toMatchObject({
      query: "two words",
      limit: 2,
      sources: [{ type: "web" }],
    });

    const json = await run(
      "firecrawl search x --json | jq -r '.id, .creditsUsed, .data.web[0].url'",
    );
    expect(json.text).toBe("search-1\n2\nhttps://first.test\n");
  });

  it("treats words and anything after -- as the query, not as options", async () => {
    await run("firecrawl search help desk; firecrawl search -- --limit -h");
    expect(calls.map(call => call.body.query)).toEqual([
      "help desk",
      "--limit -h",
    ]);
  });

  it("rejects a JSON body without a command", async () => {
    for (const body of ['{"cmd": "echo hi"}', "{not json"]) {
      const res = await request(base).post("/v2/bash").type("json").send(body);
      expect(res.status).toBe(400);
      expect(res.text).toContain('{"command": "..."}');
    }
  });

  it("shows the API's own error, such as a keyless limit, and exits 1", async () => {
    respond = () => ({
      status: 429,
      json: { success: false, error: "You've hit the keyless limit." },
    });
    const res = await run("firecrawl search anything");
    expect(res.text).toBe("Error: You've hit the keyless limit.\n[exit 1]\n");
    expect(res.headers["x-exit-code"]).toBe("1");
  });

  it("explains a bare keyless refusal", async () => {
    respond = () => ({
      status: 401,
      json: { success: false, error: "Unauthorized" },
    });
    const res = await run("firecrawl scrape https://example.com");
    expect(res.text).toContain("Create a free API key at");
    expect(res.headers["x-exit-code"]).toBe("1");
  });

  it("exits 2 without calling the API for anything outside the subset", async () => {
    const res = await run(
      [
        "firecrawl crawl https://example.com",
        "firecrawl scrape https://example.com --screenshot",
        "firecrawl scrape https://example.com -f screenshot",
        "firecrawl search x --sources alexandria",
      ].join("; echo $?; "),
    );
    expect(res.text.match(/^2$/gm)).toHaveLength(3);
    expect(res.text.match(/npx -y firecrawl-cli@latest init/g)).toHaveLength(4);
    expect(res.headers["x-exit-code"]).toBe("2");
    expect(calls).toHaveLength(0);
  });

  it("stops runaway commands and leaves out everything but text tools", async () => {
    const loop = await run("while true; do :; done");
    expect(loop.headers["x-exit-code"]).toBe("126");
    expect(Number(loop.headers["x-duration-ms"])).toBeLessThan(5000);

    const memory = await run(
      's=xxxxxxxx; for i in $(seq 1 22); do s="$s$s"; done; echo ${#s}',
    );
    expect(memory.headers["x-exit-code"]).toBe("126");

    const tools = await run(
      "sqlite3 :memory: 'select 1'; curl https://example.com; python3 -c 1",
    );
    expect(tools.headers["x-exit-code"]).toBe("127");
  });

  it("caps Firecrawl calls per command", async () => {
    const res = await run(
      "for i in $(seq 1 30); do firecrawl scrape https://example.com > /dev/null || break; done",
    );
    expect(calls).toHaveLength(25);
    expect(res.text).toContain("call limit reached (25 Firecrawl calls");
  });

  it("truncates large output", async () => {
    const res = await run(
      's=xxxxxxxx; for i in $(seq 1 17); do s="$s$s"; done; echo "$s"',
    );
    expect(res.text).toContain("[truncated at 256000 bytes]");
    expect(res.text.length).toBeLessThan(260_000);
  });

  it("rejects an oversized command", async () => {
    const res = await run(`echo ${"x".repeat(70_000)}`);
    expect(res.status).toBe(413);
  });

  it("sheds a caller that sends too many commands", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) {
      const res = await request(base)
        .get("/v2/bash")
        .set("X-Forwarded-For", "192.0.2.77");
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 60).every(status => status === 200)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
  });
});
