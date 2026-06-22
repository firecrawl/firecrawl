import { describe, test, expect } from "@jest/globals";
import { ResearchClient } from "../../../v2/methods/research";
import { SdkError } from "../../../v2/types";
import type { HttpClient } from "../../../v2/utils/httpClient";

/** Build a ResearchClient whose http.get records the requested URL. */
function makeClient(
  responder: (url: string) => { status: number; data: any } = () => ({
    status: 200,
    data: {},
  }),
) {
  const calls: string[] = [];
  const http = {
    get: async (url: string) => {
      calls.push(url);
      return responder(url);
    },
  } as unknown as HttpClient;
  return { client: new ResearchClient(http), calls };
}

/** Make an axios-like error carrying an RFC 7807 Problem body. */
function problemError(status: number, body: any) {
  return { isAxiosError: true, response: { status, data: body }, message: "req failed" };
}

describe("research.searchPapers", () => {
  test("builds query string with explode arrays", async () => {
    const { client, calls } = makeClient(() => ({
      status: 200,
      data: { results: [] },
    }));
    await client.searchPapers("diffusion models", {
      k: 10,
      authors: ["Ho", "Abbeel"],
      categories: ["cs.LG", "stat.ML"],
      from: "2020-01-01",
      to: "2024-12-31",
    });
    const url = calls[0];
    expect(url.startsWith("/v2/search/research/papers?")).toBe(true);
    const qs = new URLSearchParams(url.split("?")[1]);
    expect(qs.get("query")).toBe("diffusion models");
    expect(qs.get("k")).toBe("10");
    expect(qs.getAll("authors")).toEqual(["Ho", "Abbeel"]);
    expect(qs.getAll("categories")).toEqual(["cs.LG", "stat.ML"]);
    expect(qs.get("from")).toBe("2020-01-01");
    expect(qs.get("to")).toBe("2024-12-31");
  });

  test("omits absent options", async () => {
    const { client, calls } = makeClient(() => ({ status: 200, data: { results: [] } }));
    await client.searchPapers("q");
    const qs = new URLSearchParams(calls[0].split("?")[1]);
    expect([...qs.keys()]).toEqual(["query"]);
  });

  test("rejects empty query", async () => {
    const { client } = makeClient();
    await expect(client.searchPapers("  ")).rejects.toThrow(/query cannot be empty/i);
  });

  test("rejects non-positive k", async () => {
    const { client } = makeClient();
    await expect(client.searchPapers("q", { k: 0 })).rejects.toThrow(/k must be positive/i);
  });

  test("returns the response body verbatim", async () => {
    const payload = { results: [{ paperId: "1", title: "t", abstract: "a", score: 0.1 }] };
    const { client } = makeClient(() => ({ status: 200, data: payload }));
    await expect(client.searchPapers("q")).resolves.toEqual(payload);
  });
});

describe("research.getPaper", () => {
  test("detail mode encodes the id and sends no query params", async () => {
    const { client, calls } = makeClient(() => ({ status: 200, data: { paper: {} } }));
    await client.getPaper("arxiv:2105.05233");
    expect(calls[0]).toBe("/v2/search/research/papers/arxiv%3A2105.05233");
  });

  test("read mode adds query and k", async () => {
    const { client, calls } = makeClient(() => ({
      status: 200,
      data: { paper: {}, paperId: "1", query: "q", passages: [] },
    }));
    await client.getPaper("123", { query: "noise schedule", k: 4 });
    const [path, query] = calls[0].split("?");
    expect(path).toBe("/v2/search/research/papers/123");
    const qs = new URLSearchParams(query);
    expect(qs.get("query")).toBe("noise schedule");
    expect(qs.get("k")).toBe("4");
  });

  test("rejects k without query", async () => {
    const { client } = makeClient();
    await expect(client.getPaper("123", { k: 4 } as any)).rejects.toThrow(
      /k is only valid together with query/i,
    );
  });
});

describe("research.similarPapers", () => {
  test("requires intent", async () => {
    const { client } = makeClient();
    await expect(
      client.similarPapers("123", { intent: "" }),
    ).rejects.toThrow(/intent cannot be empty/i);
  });

  test("builds path and query with repeated anchors and rerank", async () => {
    const { client, calls } = makeClient(() => ({
      status: 200,
      data: { results: [], poolSize: 0, truncated: false },
    }));
    await client.similarPapers("2105.05233", {
      intent: "diffusion image synthesis",
      mode: "citers",
      k: 20,
      rerank: false,
      anchor: ["arxiv:2006.11239", "1503.03585"],
    });
    const [path, query] = calls[0].split("?");
    expect(path).toBe("/v2/search/research/papers/2105.05233/similar");
    const qs = new URLSearchParams(query);
    expect(qs.get("intent")).toBe("diffusion image synthesis");
    expect(qs.get("mode")).toBe("citers");
    expect(qs.get("k")).toBe("20");
    expect(qs.get("rerank")).toBe("false");
    expect(qs.getAll("anchor")).toEqual(["arxiv:2006.11239", "1503.03585"]);
  });
});

describe("research.searchGithub", () => {
  test("builds query string", async () => {
    const { client, calls } = makeClient(() => ({ status: 200, data: { results: [] } }));
    await client.searchGithub("milvus hybrid search", { k: 10 });
    const qs = new URLSearchParams(calls[0].split("?")[1]);
    expect(calls[0].startsWith("/v2/search/research/github?")).toBe(true);
    expect(qs.get("query")).toBe("milvus hybrid search");
    expect(qs.get("k")).toBe("10");
  });
});

describe("research error mapping", () => {
  test("maps RFC 7807 Problem detail to SdkError", async () => {
    const { client } = makeClient(() => {
      throw problemError(400, {
        type: "urn:search-pipeline:invalid_request",
        title: "Bad Request",
        status: 400,
        detail: "query is required",
      });
    });
    await expect(client.searchPapers("q")).rejects.toMatchObject({
      message: "query is required",
      status: 400,
    } as Partial<SdkError>);
  });

  test("falls back to title when detail is absent", async () => {
    const { client } = makeClient(() => {
      throw problemError(404, { title: "Not Found", status: 404 });
    });
    await expect(client.getPaper("999")).rejects.toThrow(/Not Found/);
  });
});
