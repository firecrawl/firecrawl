import { hangarBrowserOptions } from "./browser-options";

describe("hangarBrowserOptions", () => {
  it("maps blockAds to Hangar's uBlock extension", () => {
    expect(hangarBrowserOptions({ blockAds: true })).toEqual({
      extensions: ["ublock"],
    });
    expect(hangarBrowserOptions({ blockAds: false })).toEqual({
      extensions: [],
    });
  });
});
