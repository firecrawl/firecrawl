import {
  browserOptionsFromScrape,
  hangarBrowserOptions,
  isBrowserOptions,
} from "./browser-options";

describe("browser options", () => {
  it("blocks ads unless the scrape opted out", () => {
    expect(browserOptionsFromScrape({})).toEqual({ blockAds: true });
    expect(browserOptionsFromScrape({ blockAds: false })).toEqual({
      blockAds: false,
    });
  });

  it("maps blockAds to Hangar's uBlock extension", () => {
    expect(hangarBrowserOptions({ blockAds: true })).toEqual({
      extensions: ["ublock"],
    });
    expect(hangarBrowserOptions({ blockAds: false })).toEqual({
      extensions: [],
    });
  });

  it("maps the profile to Hangar's field names", () => {
    expect(
      hangarBrowserOptions({
        blockAds: true,
        profile: { name: "claims", saveChanges: false },
      }),
    ).toEqual({
      extensions: ["ublock"],
      profile: { name: "claims", save_changes: false },
    });
  });

  it("rejects malformed stored options", () => {
    expect(isBrowserOptions({ blockAds: true })).toBe(true);
    expect(isBrowserOptions({})).toBe(false);
    expect(isBrowserOptions({ blockAds: "yes" })).toBe(false);
    expect(isBrowserOptions({ blockAds: true, profile: { name: 1 } })).toBe(
      false,
    );
  });
});
