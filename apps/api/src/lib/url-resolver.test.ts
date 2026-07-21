import {
  mergeResolvedMetadata,
  parseUrlResolverResponse,
} from "./url-resolver";

describe("parseUrlResolverResponse", () => {
  it("preserves generic links and opaque metadata", () => {
    expect(
      parseUrlResolverResponse({
        links: [
          {
            url: "https://resolver.test/items/1",
            title: "Item 1",
            description: "Resolved item",
          },
        ],
        metadata: {
          provider: "example",
          score: 42,
          attributes: { verified: true },
        },
      }),
    ).toEqual({
      links: [
        {
          url: "https://resolver.test/items/1",
          title: "Item 1",
          description: "Resolved item",
        },
      ],
      metadata: {
        provider: "example",
        score: 42,
        attributes: { verified: true },
      },
    });
  });

  it.each([
    null,
    {},
    { links: "not-an-array" },
    { links: [{}] },
    { links: [{ url: "https://resolver.test", title: 123 }] },
    { links: [], metadata: [] },
  ])("rejects invalid resolver responses", value => {
    expect(() => parseUrlResolverResponse(value)).toThrow();
  });
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
