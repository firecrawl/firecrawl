import { search } from "../../../v2/methods/search";

const fakeHttp = {
  post: jest.fn(),
} as any;

describe("SearchData .data helpful error", () => {
  beforeEach(() => jest.clearAllMocks());

  it("throws with available sources when .data is accessed", async () => {
    fakeHttp.post.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          web: [{ title: "Test", url: "http://a.com" }],
        },
      },
    });

    const result = await search(fakeHttp, { query: "test" });
    expect(result.web).toHaveLength(1);
    expect(() => (result as any).data).toThrow(
      /SearchData has no '\.data'.*\.web \(1 results\)/,
    );
  });

  it("throws with multiple sources listed", async () => {
    fakeHttp.post.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          web: [{ title: "W", url: "http://a.com" }],
          news: [{ title: "N", url: "http://b.com" }],
        },
      },
    });

    const result = await search(fakeHttp, { query: "test" });
    expect(() => (result as any).data).toThrow(/\.web.*\.news/);
  });

  it("throws with generic message when empty", async () => {
    fakeHttp.post.mockResolvedValue({
      status: 200,
      data: { success: true, data: {} },
    });

    const result = await search(fakeHttp, { query: "test" });
    expect(() => (result as any).data).toThrow("grouped by source");
  });

  it("does not show .data in Object.keys", async () => {
    fakeHttp.post.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: { web: [{ title: "T", url: "http://a.com" }] },
      },
    });

    const result = await search(fakeHttp, { query: "test" });
    expect(Object.keys(result)).not.toContain("data");
  });
});
