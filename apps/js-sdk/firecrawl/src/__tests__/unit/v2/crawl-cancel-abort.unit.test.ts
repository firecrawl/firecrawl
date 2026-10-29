import { describe, test, expect } from "vitest";
import { FirecrawlClient } from "../../../v2/client";
import { HttpClient } from "../../../v2/utils/httpClient";
import { waitForCrawlCompletion } from "../../../v2/methods/crawl";
import { SdkError } from "../../../v2/types";
import { mockFetch, type MockReply, type SentRequest } from "../helpers/mockFetch";

const API_URL = "https://api.firecrawl.dev";
const JOB_ID = "job-123";

type Reply = { status: number; data: unknown };

function makeClient(route: (req: SentRequest) => MockReply | Promise<MockReply>) {
  const client = new FirecrawlClient({ apiKey: "fc-test", apiUrl: API_URL });
  const sent = mockFetch(route);
  return { client, sent };
}

// The cancel runs in the background, so let its request reach fetch.
const flush = () => new Promise((r) => setTimeout(r, 0));

const running: Reply = { status: 200, data: { success: true, status: "scraping", completed: 0, total: 1, data: [] } };
const started: Reply = { status: 200, data: { success: true, id: JOB_ID, url: "https://example.com" } };

describe("v2 cancelCrawl", () => {
  test("returns false when the crawl is already completed (409)", async () => {
    const { client, sent } = makeClient(() => ({ status: 409, data: { error: "Crawl is already completed" } }));
    await expect(client.cancelCrawl(JOB_ID)).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "delete", path: `/v2/crawl/${JOB_ID}` });
  });

  test("returns true when the crawl is cancelled", async () => {
    const { client } = makeClient(() => ({ status: 200, data: { status: "cancelled" } }));
    await expect(client.cancelCrawl(JOB_ID)).resolves.toBe(true);
  });

  test("still throws for other errors", async () => {
    const { client } = makeClient(() => ({ status: 404, data: { error: "Job not found" } }));
    const err = await client.cancelCrawl(JOB_ID).catch((e) => e);
    expect(err).toBeInstanceOf(SdkError);
    expect(err.status).toBe(404);
  });
});

describe("v2 crawl with an AbortSignal", () => {
  test("abort during polling stops polling, cancels the job, and rejects with the abort reason", async () => {
    const controller = new AbortController();
    let polls = 0;
    const { client, sent } = makeClient((req) => {
      if (req.method === "post") return started;
      if (req.method === "delete") return { status: 200, data: { status: "cancelled" } };
      polls += 1;
      if (polls === 1) setTimeout(() => controller.abort(), 10);
      return running;
    });

    const t0 = Date.now();
    const err = await client.crawl("https://example.com", { pollInterval: 30, signal: controller.signal }).catch((e) => e);

    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toBe(controller.signal.reason);
    expect((err as Error).name).toBe("AbortError");
    await flush();
    expect(sent.map((r) => r.method)).toEqual(["post", "get", "delete"]);
    expect(sent[2]!.path).toBe(`/v2/crawl/${JOB_ID}`);
  });

  test("rejects with a custom abort reason and ignores a failing cancel", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const { client, sent } = makeClient((req) => {
      if (req.method === "post") return started;
      if (req.method === "delete") return { status: 500, data: { error: "boom" } };
      setTimeout(() => controller.abort(reason), 10);
      return running;
    });

    await expect(client.crawl("https://example.com", { pollInterval: 30, signal: controller.signal })).rejects.toBe(reason);
    await flush();
    expect(sent.some((r) => r.method === "delete")).toBe(true);
  });

  test("a hanging cancel does not delay the rejection", async () => {
    const controller = new AbortController();
    const methods: string[] = [];
    const { client } = makeClient((req) => {
      methods.push(req.method);
      if (req.method === "delete") return new Promise<MockReply>(() => {});
      if (req.method === "get") setTimeout(() => controller.abort(), 10);
      return req.method === "post" ? started : running;
    });

    // Read the reason after the abort: before it, signal.reason is undefined.
    const err = await client.crawl("https://example.com", { pollInterval: 30, signal: controller.signal }).catch((e) => e);
    expect(err).toBe(controller.signal.reason);
    expect((err as Error).name).toBe("AbortError");
    await flush();
    expect(methods).toEqual(["post", "get", "delete"]);
  });

  test("abort while the start request is in flight cancels the job once the id arrives", async () => {
    const controller = new AbortController();
    const { client, sent } = makeClient((req) => {
      if (req.method === "post") {
        controller.abort();
        return started;
      }
      if (req.method === "delete") return { status: 200, data: { status: "cancelled" } };
      return running;
    });

    const err = await client.crawl("https://example.com", { signal: controller.signal }).catch((e) => e);
    expect(err).toBe(controller.signal.reason);
    expect((err as Error).name).toBe("AbortError");
    await flush();
    expect(sent.map((r) => r.method)).toEqual(["post", "delete"]);
  });

  test("an already aborted signal sends no request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, sent } = makeClient(() => started);

    await expect(client.crawl("https://example.com", { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(sent).toHaveLength(0);
  });

  test("the signal is not sent in the crawl request body", async () => {
    const controller = new AbortController();
    const bodies: unknown[] = [];
    const { client } = makeClient((req) => {
      if (req.method === "post") bodies.push(req.body);
      return req.method === "post" ? started : { data: { success: true, status: "completed", completed: 1, total: 1, data: [] } };
    });

    const job = await client.crawl("https://example.com", { limit: 1, signal: controller.signal });
    expect(job.status).toBe("completed");
    expect(bodies[0]).toMatchObject({ url: "https://example.com", limit: 1 });
    expect(Object.keys(bodies[0] as object)).not.toContain("signal");
  });
});

describe("v2 waitForCrawlCompletion with an AbortSignal", () => {
  test("stops polling and rejects without cancelling the job", async () => {
    const http = new HttpClient({ apiKey: "fc-test", apiUrl: API_URL });
    const controller = new AbortController();
    const sent = mockFetch(() => {
      setTimeout(() => controller.abort(), 10);
      return running;
    });

    const err = await waitForCrawlCompletion(http, JOB_ID, 30, undefined, controller.signal).catch((e) => e);
    expect(err).toBe(controller.signal.reason);
    expect((err as Error).name).toBe("AbortError");
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.map((r) => r.method)).toEqual(["get"]);
  });
});
