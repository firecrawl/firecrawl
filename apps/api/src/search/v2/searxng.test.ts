import axios from "axios";
import { searxng_search } from "./searxng";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

vi.mock("../../config", () => ({
  config: {
    SEARXNG_ENDPOINT: "http://localhost:8888/",
    SEARXNG_ENGINES: "",
    SEARXNG_CATEGORIES: "",
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockedGet = vi.mocked(axios.get);

const BACKEND_RESPONSE = {
  results: [
    {
      url: "https://example.com/a",
      title: "A",
      content: "snippet a",
      raw_content: "full page text a",
    },
    {
      url: "https://example.com/b",
      title: "B",
      content: "snippet b",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGet.mockResolvedValue({ data: BACKEND_RESPONSE });
});

describe("searxng_search raw content", () => {
  it("does not ask for raw content by default", async () => {
    const results = await searxng_search("rust", { num_results: 5 });

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const params = mockedGet.mock.calls[0][1]?.params as any;
    expect(params).not.toHaveProperty("include_raw_content");
    expect(params).toMatchObject({ q: "rust", format: "json", pageno: 1 });

    // The backend's raw_content is still mapped when it sends it.
    expect(results.web?.[0].rawContent).toBe("full page text a");
    expect(results.web?.[1].rawContent).toBeUndefined();
  });

  it("sends include_raw_content=1 when opted in", async () => {
    const results = await searxng_search("rust", {
      num_results: 5,
      include_raw_content: true,
    });

    const params = mockedGet.mock.calls[0][1]?.params as any;
    expect(params.include_raw_content).toBe(1);
    expect(results.web?.[0]).toEqual({
      url: "https://example.com/a",
      title: "A",
      description: "snippet a",
      rawContent: "full page text a",
    });
  });

  it("ignores empty or non-string raw_content values", async () => {
    mockedGet.mockResolvedValue({
      data: {
        results: [
          {
            url: "https://example.com/c",
            title: "C",
            content: "s",
            raw_content: "",
          },
          {
            url: "https://example.com/d",
            title: "D",
            content: "s",
            raw_content: 42,
          },
        ],
      },
    });

    const results = await searxng_search("rust", {
      num_results: 5,
      include_raw_content: true,
    });

    expect(results.web?.[0].rawContent).toBeUndefined();
    expect(results.web?.[1].rawContent).toBeUndefined();
  });
});
