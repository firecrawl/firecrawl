import { fetch } from "undici";
import { config } from "../config";
import {
  compileResolveRegex,
  mergeResolvedMetadata,
  parseUrlResolverErrorDetail,
  parseUrlResolverMetadataResponse,
  resetUrlResolverCacheForTest,
  resolveUrlMetadata,
} from "./url-resolver";

vi.mock("undici", () => ({
  Agent: class {},
  fetch: vi.fn(),
}));

const originalServiceUrl = config.AVGRAB_SERVICE_URL;
const logger = {
  info: vi.fn(),
  error: vi.fn(),
} as any;

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as any;
}

describe("URL resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.AVGRAB_SERVICE_URL = "http://resolver.test";
    resetUrlResolverCacheForTest();
  });

  afterAll(() => {
    config.AVGRAB_SERVICE_URL = originalServiceUrl;
  });

  it("preserves opaque metadata", () => {
    expect(
      parseUrlResolverMetadataResponse({
        metadata: {
          provider: "example",
          score: 42,
          attributes: { verified: true },
        },
      }),
    ).toEqual({
      provider: "example",
      score: 42,
      attributes: { verified: true },
    });
  });

  it.each([null, {}, { metadata: null }, { metadata: [] }])(
    "rejects invalid resolver metadata responses",
    value => {
      expect(() => parseUrlResolverMetadataResponse(value)).toThrow();
    },
  );

  it("preserves canonical metadata on collisions", () => {
    expect(
      mergeResolvedMetadata(
        {
          url: "https://resolver.test/untrusted",
          statusCode: 418,
          score: 42,
        },
        {
          url: "https://resolver.test/canonical",
          statusCode: 200,
          proxyUsed: "basic",
        },
      ),
    ).toEqual({
      url: "https://resolver.test/canonical",
      statusCode: 200,
      proxyUsed: "basic",
      score: 42,
    });
  });

  it("rejects unsafe and oversized capability patterns", () => {
    expect(() => compileResolveRegex("(a+)+$")).toThrow("unsafe URL pattern");
    expect(() => compileResolveRegex("a".repeat(1_025))).toThrow(
      "unsafe URL pattern",
    );
  });

  it("normalizes invalid error bodies", () => {
    expect(parseUrlResolverErrorDetail(null)).toBe("Unknown error");
    expect(parseUrlResolverErrorDetail({ detail: "Unavailable" })).toBe(
      "Unavailable",
    );
  });

  it("shares one capability request across concurrent resolutions", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(200, { resolve_regex: "https?://resolver\\.test/.+" }),
      )
      .mockResolvedValueOnce(response(200, { metadata: { score: 1 } }))
      .mockResolvedValueOnce(response(200, { metadata: { score: 2 } }));

    await expect(
      Promise.all([
        resolveUrlMetadata("https://resolver.test/one", logger),
        resolveUrlMetadata("https://resolver.test/two", logger),
      ]),
    ).resolves.toEqual([{ score: 1 }, { score: 2 }]);

    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/supported-urls")),
    ).toHaveLength(1);
  });

  it("treats not found as an expected metadata miss", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(200, { resolve_regex: "https?://resolver\\.test/.+" }),
      )
      .mockResolvedValueOnce(response(404, null));

    await expect(
      resolveUrlMetadata("https://resolver.test/missing", logger),
    ).resolves.toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("uses the fallback detail for null HTTP error bodies", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(200, { resolve_regex: "https?://resolver\\.test/.+" }),
      )
      .mockResolvedValueOnce(response(500, null));

    await expect(
      resolveUrlMetadata("https://resolver.test/failure", logger),
    ).rejects.toThrow("Unknown error");
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("propagates aborts to the resolver request", async () => {
    const controller = new AbortController();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(200, { resolve_regex: "https?://resolver\\.test/.+" }),
      )
      .mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }) as any;
      });

    const resolving = resolveUrlMetadata(
      "https://resolver.test/slow",
      logger,
      controller.signal,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort(new Error("scrape aborted"));

    await expect(resolving).rejects.toThrow("scrape aborted");
  });
});
