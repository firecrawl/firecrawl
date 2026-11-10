import { checkPermissions } from "./permissions";
import { usOnlyLocationRefusal } from "./us-only";

const usOnly = { usOnly: true };

describe("usOnlyLocationRefusal", () => {
  it("refuses a country outside the US for a US-only team", () => {
    expect(usOnlyLocationRefusal(usOnly, "nl")).toBe(
      'location.country "NL" isn\'t available to teams restricted to US-only processing, because pages are fetched only from US exits. Omit location or set it to "US".',
    );
  });

  it.each(["us", "US", "us-generic", "US-generic", "", null, 42, undefined])(
    "allows %s",
    country => {
      expect(usOnlyLocationRefusal(usOnly, country)).toBeUndefined();
    },
  );

  it("refuses us-whitelist, which isn't the US", () => {
    expect(usOnlyLocationRefusal(usOnly, "us-whitelist")).toContain(
      'location.country "US-WHITELIST"',
    );
  });

  it("names the first country outside the US", () => {
    expect(
      usOnlyLocationRefusal(usOnly, "us", undefined, "fr", "de"),
    ).toContain('"FR"');
  });

  it("leaves teams without the restriction alone", () => {
    expect(usOnlyLocationRefusal(undefined, "nl")).toBeUndefined();
    expect(usOnlyLocationRefusal(null, "nl")).toBeUndefined();
    expect(usOnlyLocationRefusal({ usOnly: false }, "nl")).toBeUndefined();
  });
});

describe("checkPermissions for US-only teams", () => {
  it.each([
    ["location", { location: { country: "nl" } }],
    ["v1 geolocation", { geolocation: { country: "NL" } }],
    [
      "scrapeOptions.location",
      { scrapeOptions: { location: { country: "nl" } } },
    ],
    [
      "scrapeOptions.geolocation",
      { scrapeOptions: { geolocation: { country: "NL" } } },
    ],
  ])("refuses a non-US %s with US_ONLY_UNAVAILABLE", (_, request) => {
    const result = checkPermissions(request, usOnly);
    expect(result.code).toBe("US_ONLY_UNAVAILABLE");
    expect(result.error).toContain('location.country "NL"');
  });

  it("refuses us-whitelist with US_ONLY_UNAVAILABLE", () => {
    expect(
      checkPermissions({ location: { country: "us-whitelist" } }, usOnly).code,
    ).toBe("US_ONLY_UNAVAILABLE");
  });

  it("allows a US location or none", () => {
    expect(checkPermissions({ location: { country: "us" } }, usOnly)).toEqual(
      {},
    );
    expect(
      checkPermissions({ location: { country: "us-generic" } }, usOnly),
    ).toEqual({});
    expect(
      checkPermissions({ geolocation: { country: "US-generic" } }, usOnly),
    ).toEqual({});
    expect(checkPermissions({}, usOnly)).toEqual({});
  });

  it("leaves other teams' locations alone", () => {
    expect(checkPermissions({ location: { country: "nl" } }, null)).toEqual({});
    expect(
      checkPermissions({ location: { country: "nl" } }, { usOnly: false }),
    ).toEqual({});
  });
});
