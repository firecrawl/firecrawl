import {
  mergeResolvedMetadata,
  parseUrlResolverMetadataResponse,
} from "./url-resolver";

describe("parseUrlResolverMetadataResponse", () => {
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
});

describe("mergeResolvedMetadata", () => {
  it("adds opaque fields while preserving canonical metadata on collisions", () => {
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
});
