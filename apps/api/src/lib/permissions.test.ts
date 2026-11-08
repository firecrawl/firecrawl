import { config } from "../config";
import { checkPermissions } from "./permissions";

describe("checkPermissions — threat protection", () => {
  const requestWithOption = { threatProtection: { mode: "normal" } };

  it("allows requests without a threatProtection option regardless of flags", () => {
    expect(checkPermissions({}, null)).toEqual({});
    expect(checkPermissions({}, { threatProtection: "disabled" })).toEqual({});
  });

  it("rejects a per-request option when the flag is missing or disabled", () => {
    expect(checkPermissions(requestWithOption, null).error).toMatch(
      /enterprise feature/,
    );
    expect(
      checkPermissions(requestWithOption, { threatProtection: "disabled" })
        .error,
    ).toMatch(/enterprise feature/);
  });

  it.each(["allowed", "forced"] as const)(
    "allows a per-request option when the flag is %s",
    mode => {
      expect(
        checkPermissions(requestWithOption, { threatProtection: mode }),
      ).toEqual({});
    },
  );

  it("rejects a per-request option when the org disables overrides", () => {
    const result = checkPermissions(
      requestWithOption,
      { threatProtection: "allowed" },
      { threatProtectionOrgConfig: { allowRequestOverrides: false } },
    );
    expect(result.error).toMatch(/overrides are disabled/);
  });

  it("allows a per-request option when the org config allows overrides", () => {
    expect(
      checkPermissions(
        requestWithOption,
        { threatProtection: "allowed" },
        { threatProtectionOrgConfig: { allowRequestOverrides: true } },
      ),
    ).toEqual({});
    expect(
      checkPermissions(
        requestWithOption,
        { threatProtection: "allowed" },
        { threatProtectionOrgConfig: null },
      ),
    ).toEqual({});
  });
});

describe("checkPermissions — FAST_CRAWL robots overrides", () => {
  const robotsRequest = { crawlerOptions: { robotsUserAgent: "CustomBot" } };

  afterEach(() => {
    delete (config as any).FAST_CRAWL;
  });

  it("rejects robotsUserAgent without the enterprise flag when FAST_CRAWL is unset", () => {
    expect(checkPermissions(robotsRequest, null).error).toMatch(
      /enterprise feature/,
    );
  });

  it("allows robotsUserAgent without the enterprise flag when FAST_CRAWL is set", () => {
    (config as any).FAST_CRAWL = true;
    expect(checkPermissions(robotsRequest, null)).toEqual({});
  });

  it("still allows robotsUserAgent with the enterprise flag when FAST_CRAWL is set", () => {
    (config as any).FAST_CRAWL = true;
    expect(
      checkPermissions(robotsRequest, { customRobotsAgent: "allowed" } as any),
    ).toEqual({});
  });
});
