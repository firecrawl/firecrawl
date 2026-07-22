import { resolveViaAvgrab } from "./avgrab-resolve";
import { MapFailedError } from "./error";
import { resolveUrl, UrlResolverHttpError } from "./url-resolver";

vi.mock("./url-resolver", () => {
  class MockUrlResolverHttpError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    resolveUrl: vi.fn(),
    UrlResolverHttpError: MockUrlResolverHttpError,
  };
});

const logger = {} as any;

describe("resolveViaAvgrab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps shared resolver posts without changing map output", async () => {
    vi.mocked(resolveUrl).mockResolvedValue({
      posts: [
        {
          url: "https://resolver.test/post",
          title: "Post title",
          date: "2026-07-22T00:00:00Z",
          type: "image",
          media: ["https://resolver.test/image.jpg"],
        },
      ],
    });

    await expect(
      resolveViaAvgrab("https://resolver.test/profile", 10, logger),
    ).resolves.toEqual([
      {
        url: "https://resolver.test/post",
        title: "Post title",
        description: JSON.stringify({
          date: "2026-07-22T00:00:00Z",
          type: "image",
          media: ["https://resolver.test/image.jpg"],
        }),
      },
    ]);
    expect(resolveUrl).toHaveBeenCalledWith(
      "https://resolver.test/profile",
      logger,
      { requestBody: { limit: 10 } },
    );
  });

  it("preserves map failure handling for resolver HTTP errors", async () => {
    vi.mocked(resolveUrl).mockRejectedValue(
      new UrlResolverHttpError(502, "resolver failed"),
    );

    await expect(
      resolveViaAvgrab("https://resolver.test/profile", 10, logger),
    ).rejects.toEqual(new MapFailedError("resolver failed"));
  });
});
