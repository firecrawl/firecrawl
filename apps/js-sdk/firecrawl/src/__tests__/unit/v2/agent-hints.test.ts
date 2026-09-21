import { describe, expect, it, jest } from "@jest/globals";
import { search } from "../../../v2/methods/search";
import { scrape } from "../../../v2/methods/scrape";
import { parse } from "../../../v2/methods/parse";
import { map } from "../../../v2/methods/map";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../../../v2/utils/errorHandler";

const hints = [
  "Scrape a selected search result if you need full page content.",
  "Evaluate this result before submitting feedback.",
];
function httpFor(body: object) {
  return {
    post: jest.fn<any>().mockResolvedValue({ status: 200, data: body }),
    postMultipart: jest
      .fn<any>()
      .mockResolvedValue({ status: 200, data: body }),
  } as any;
}

describe("agent hints survive SDK response unwrapping", () => {
  it("preserves search hints without adding them to records", async () => {
    const web = [{ url: "https://example.com" }];
    const result = await search(
      httpFor({ success: true, data: { web }, agent_hints: hints }),
      { query: "test" },
    );
    expect(result.web).toEqual(web);
    expect(result.web[0]).not.toHaveProperty("agent_hints");
    expect(result.agent_hints).toEqual(hints);
    expect(JSON.parse(JSON.stringify(result)).agent_hints).toEqual(hints);
  });

  it("keeps existing search output unchanged when hints are absent", async () => {
    const result = await search(httpFor({ success: true, data: { web: [] } }), {
      query: "test",
    });
    expect(Object.keys(result)).toEqual(["web"]);
  });

  it.each(["scrape", "parse"])(
    "keeps %s hints separate from document content",
    async (method) => {
      const http = httpFor({
        success: true,
        data: { markdown: "# Page" },
        agent_hints: hints,
      });
      const result =
        method === "scrape"
          ? await scrape(http, "https://example.com")
          : await parse(http, { filename: "page.txt", data: "Page" });
      expect(result.markdown).toBe("# Page");
      expect(result.agent_hints).toEqual(hints);
    },
  );

  it("preserves map metadata alongside normalized links", async () => {
    const result = await map(
      httpFor({
        success: true,
        id: "map-id",
        links: ["https://example.com"],
        agent_hints: hints,
      }),
      "https://example.com",
    );
    expect(result).toEqual({
      id: "map-id",
      links: [{ url: "https://example.com" }],
      agent_hints: hints,
    });
  });

  it.each([null, "unexpected", [123]])(
    "ignores malformed optional hints: %j",
    async (value) => {
      const result = await search(
        httpFor({ success: true, data: {}, agent_hints: value }),
        { query: "test" },
      );
      expect(result).not.toHaveProperty("agent_hints");
    },
  );

  it("preserves hints on HTTP and Axios errors without changing their status", () => {
    const response = {
      status: 400,
      data: {
        success: false,
        code: "INVALID",
        error: "Invalid request",
        agent_hints: hints,
      },
    } as any;
    for (const raise of [
      () => throwForBadResponse(response, "search"),
      () =>
        normalizeAxiosError({ response, isAxiosError: true } as any, "search"),
    ]) {
      try {
        raise();
        throw new Error("Expected SDK error");
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          code: "INVALID",
          agent_hints: hints,
        });
      }
    }
  });
});
