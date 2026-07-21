import { resolveUrl, supportsUrlResolver } from "../../../../lib/url-resolver";
import { resolverMetadataPostprocessor } from "../resolver-metadata";

vi.mock("../../../../lib/url-resolver", () => ({
  resolveUrl: vi.fn(),
  supportsUrlResolver: vi.fn(),
}));

const mockedResolveUrl = vi.mocked(resolveUrl);
const mockedSupportsUrlResolver = vi.mocked(supportsUrlResolver);

const buildMeta = (lockdown = false) =>
  ({
    url: "https://resolver.test/source",
    options: { lockdown },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }) as any;

const buildEngineResult = () =>
  ({
    url: "https://resolver.test/source",
    html: "<main>Original content</main>",
    markdown: "Original content",
    statusCode: 200,
    proxyUsed: "basic",
  }) as any;

describe("resolverMetadataPostprocessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("runs only for URLs advertised by the resolver service", async () => {
    mockedSupportsUrlResolver.mockResolvedValue(true);

    await expect(
      resolverMetadataPostprocessor.shouldRun(
        buildMeta(),
        new URL("https://resolver.test/source"),
      ),
    ).resolves.toBe(true);

    expect(mockedSupportsUrlResolver).toHaveBeenCalledWith(
      "https://resolver.test/source",
    );
  });

  it("does not contact the resolver in lockdown or after processing", async () => {
    await expect(
      resolverMetadataPostprocessor.shouldRun(
        buildMeta(true),
        new URL("https://resolver.test/source"),
      ),
    ).resolves.toBe(false);
    await expect(
      resolverMetadataPostprocessor.shouldRun(
        buildMeta(),
        new URL("https://resolver.test/source"),
        ["resolver-metadata"],
      ),
    ).resolves.toBe(false);

    expect(mockedSupportsUrlResolver).not.toHaveBeenCalled();
  });

  it("adds resolver metadata without changing scraped content", async () => {
    mockedResolveUrl.mockResolvedValue({
      links: [],
      metadata: {
        provider: "example",
        score: 42,
      },
    });
    const engineResult = buildEngineResult();

    const result = await resolverMetadataPostprocessor.run(
      buildMeta(),
      engineResult,
    );

    expect(mockedResolveUrl).toHaveBeenCalledWith(
      "https://resolver.test/source",
      0,
      expect.anything(),
    );
    expect(result).toEqual({
      ...engineResult,
      resolvedMetadata: {
        provider: "example",
        score: 42,
      },
      postprocessorsUsed: ["resolver-metadata"],
    });
    expect(result.markdown).toBe("Original content");
    expect(result.html).toBe("<main>Original content</main>");
  });

  it("leaves the scrape unchanged when no metadata is returned", async () => {
    mockedResolveUrl.mockResolvedValue({ links: [] });
    const engineResult = buildEngineResult();

    await expect(
      resolverMetadataPostprocessor.run(buildMeta(), engineResult),
    ).resolves.toBe(engineResult);
  });
});
