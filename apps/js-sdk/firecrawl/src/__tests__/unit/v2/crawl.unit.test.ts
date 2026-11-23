import { describe, test, expect } from "vitest";
import axios, { type AxiosAdapter } from "axios";
import { FirecrawlClient } from "../../../v2/client";

const API_URL = "https://api.firecrawl.dev";

function makeClient(apiKey = "fc-test") {
  const client = new FirecrawlClient({ apiKey, apiUrl: API_URL });
  const sent: Array<{ method?: string; url: string; body: any }> = [];

  const adapter: AxiosAdapter = async (config) => {
    const parsedBody = config.data ? JSON.parse(config.data) : undefined;
    sent.push({
      method: (config.method || "get").toLowerCase(),
      url: axios.getUri(config),
      body: parsedBody,
    });

    const path = new URL(axios.getUri(config)).pathname;

    if (path === "/v2/crawl" && config.method?.toLowerCase() === "post") {
      return {
        data: { success: true, id: "test-crawl-id", url: "https://example.com" },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    }

    if (path.startsWith("/v2/crawl/")) {
      return {
        data: {
          success: true,
          status: "completed",
          completed: 1,
          total: 1,
          data: [],
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    }

    return {
      data: { success: true },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };

  (client as any).http.instance.defaults.adapter = adapter;
  return { client, sent };
}

describe("v2 crawl ignoreRobotsTxt option handling", () => {
  describe("startCrawl", () => {
    test("forwards ignoreRobotsTxt: true in the request body", async () => {
      const { client, sent } = makeClient();
      const res = await client.startCrawl("https://example.com", {
        ignoreRobotsTxt: true,
      });

      expect(res.id).toBe("test-crawl-id");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe("post");
      expect(sent[0]!.url).toBe(`${API_URL}/v2/crawl`);
      expect(sent[0]!.body.ignoreRobotsTxt).toBe(true);
    });

    test("forwards ignoreRobotsTxt: false in the request body", async () => {
      const { client, sent } = makeClient();
      await client.startCrawl("https://example.com", {
        ignoreRobotsTxt: false,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe("post");
      expect(sent[0]!.body.ignoreRobotsTxt).toBe(false);
    });

    test("omits ignoreRobotsTxt when not provided", async () => {
      const { client, sent } = makeClient();
      await client.startCrawl("https://example.com");

      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).not.toHaveProperty("ignoreRobotsTxt");
    });

    test("omits ignoreRobotsTxt when explicitly undefined", async () => {
      const { client, sent } = makeClient();
      await client.startCrawl("https://example.com", {
        ignoreRobotsTxt: undefined,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).not.toHaveProperty("ignoreRobotsTxt");
    });
  });

  describe("crawl (waiter)", () => {
    test("forwards ignoreRobotsTxt: true to startCrawl in the request body", async () => {
      const { client, sent } = makeClient();
      const job = await client.crawl("https://example.com", {
        ignoreRobotsTxt: true,
      });

      expect(job.status).toBe("completed");
      const startReq = sent.find(
        (s) => s.method === "post" && s.url === `${API_URL}/v2/crawl`
      );
      expect(startReq).toBeDefined();
      expect(startReq!.body.ignoreRobotsTxt).toBe(true);
    });

    test("forwards ignoreRobotsTxt: false to startCrawl in the request body", async () => {
      const { client, sent } = makeClient();
      await client.crawl("https://example.com", {
        ignoreRobotsTxt: false,
      });

      const startReq = sent.find(
        (s) => s.method === "post" && s.url === `${API_URL}/v2/crawl`
      );
      expect(startReq).toBeDefined();
      expect(startReq!.body.ignoreRobotsTxt).toBe(false);
    });

    test("omits ignoreRobotsTxt when not provided", async () => {
      const { client, sent } = makeClient();
      await client.crawl("https://example.com");

      const startReq = sent.find(
        (s) => s.method === "post" && s.url === `${API_URL}/v2/crawl`
      );
      expect(startReq).toBeDefined();
      expect(startReq!.body).not.toHaveProperty("ignoreRobotsTxt");
    });
  });
});
