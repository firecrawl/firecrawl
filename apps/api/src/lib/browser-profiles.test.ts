import {
  browserProfileDeletedKey,
  scrapeRequestsProfileOnRenderBrowser,
} from "./browser-profiles";
const TEAM = "00000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "00000000-0000-4000-8000-000000000002";
describe("browserProfileDeletedKey", () => {
  it("isolates teams and preserves names containing separators", () => {
    expect(browserProfileDeletedKey(TEAM, "login")).not.toBe(
      browserProfileDeletedKey(OTHER_TEAM, "login"),
    );
    expect(browserProfileDeletedKey("a_b", "c")).not.toBe(
      browserProfileDeletedKey("a", "b_c"),
    );
    expect(browserProfileDeletedKey(TEAM, "a/b c")).not.toBe(
      browserProfileDeletedKey(TEAM, "a/b"),
    );
  });
});

describe("scrapeRequestsProfileOnRenderBrowser", () => {
  it("matches a screenshot format or screenshot action, and ignores other actions", () => {
    expect(
      scrapeRequestsProfileOnRenderBrowser({
        profile: { name: "login" },
        formats: [{ type: "html" }, { type: "screenshot" }],
      }),
    ).toBe(true);
    expect(
      scrapeRequestsProfileOnRenderBrowser({
        profile: { name: "login" },
        actions: [{ type: "screenshot" }],
      }),
    ).toBe(true);
    expect(
      scrapeRequestsProfileOnRenderBrowser({
        profile: { name: "login" },
        formats: [{ type: "html" }],
        actions: [{ type: "scroll" }, { type: "wait" }],
      }),
    ).toBe(false);
    expect(
      scrapeRequestsProfileOnRenderBrowser({
        formats: [{ type: "screenshot" }],
      }),
    ).toBe(false);
    expect(
      scrapeRequestsProfileOnRenderBrowser({
        profile: { name: "login" },
        formats: [{ type: "branding" }],
        actions: [{ type: "click" }],
      }),
    ).toBe(false);
    expect(
      scrapeRequestsProfileOnRenderBrowser({
        profile: { name: "login" },
        formats: [{ type: "branding" }],
        actions: [{ type: "pdf" }],
      }),
    ).toBe(true);
    expect(
      scrapeRequestsProfileOnRenderBrowser({
        profile: { name: "login" },
        formats: [{ type: "branding" }, { type: "audio" }],
      }),
    ).toBe(true);
  });
});
