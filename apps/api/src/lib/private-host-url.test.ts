import { allowsBarePrivateHost, isKnownLocalUrl } from "./private-host-url";

const denied = {
  privateScraping: false,
  legacyWebhooks: false,
  selfHostedTestSuite: false,
};

describe("bare private host URL allowance", () => {
  it("recognizes the local URLs used by self-hosted snippets", () => {
    expect(isKnownLocalUrl("http://localhost:8080/path")).toBe(true);
    expect(isKnownLocalUrl("http://192.168.1.20/path")).toBe(true);
    expect(isKnownLocalUrl("http://example.com/path")).toBe(false);
  });
  it("lets explicit self-hosted scraping reach localhost and service names", () => {
    for (const host of ["localhost", "service"]) {
      expect(
        allowsBarePrivateHost(`http://${host}:8080/path`, {
          ...denied,
          privateScraping: true,
        }),
      ).toBe(true);
    }
  });

  it("does not widen public host validation", () => {
    expect(
      allowsBarePrivateHost("https://example.com", {
        ...denied,
        privateScraping: true,
      }),
    ).toBe(false);
    expect(allowsBarePrivateHost("http://localhost:8080", denied)).toBe(false);
    expect(
      allowsBarePrivateHost("not a url", {
        ...denied,
        privateScraping: true,
      }),
    ).toBe(false);
  });

  it("keeps the legacy webhook exception test-only", () => {
    expect(
      allowsBarePrivateHost("http://localhost:8080", {
        ...denied,
        legacyWebhooks: true,
      }),
    ).toBe(false);
    expect(
      allowsBarePrivateHost("http://localhost:8080", {
        ...denied,
        legacyWebhooks: true,
        selfHostedTestSuite: true,
      }),
    ).toBe(true);
  });
});
