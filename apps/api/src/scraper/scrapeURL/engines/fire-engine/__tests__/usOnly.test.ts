import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ calls: [] as any[] }));

vi.mock("../../../lib/fetch", () => ({
  robustFetch: vi.fn(async (params: any) => {
    fake.calls.push(params);
    return { error: "Scrape failed" };
  }),
  redactRequestBodyForLog: (body: unknown) => body,
}));

vi.mock("../../../../../lib/gcs-jobs", () => ({
  getDocFromGCS: vi.fn(async () => null),
}));

import { EngineError } from "../../../error";
import {
  scrapeURLWithFireEngineChromeCDP,
  scrapeURLWithFireEngineTLSClient,
} from "../index";
import type { ResolvedSafeMode } from "../../../../../lib/safe-mode";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child() {
    return this;
  },
} as any;

const safeMode: ResolvedSafeMode = {
  lockdown: false,
  domainControls: false,
  enforceRobots: false,
  disableStealthProxy: false,
  disableAuthentication: false,
  disableSiteHandling: true,
  exposeWebdriver: false,
  useHeadlessUserAgent: false,
  disablePlatformSelection: false,
  disableCountrySelection: false,
  disableAutomaticReferrer: true,
};

function meta({
  teamFlags,
  location,
  safeMode,
}: {
  teamFlags?: { usOnly?: boolean };
  location?: { country?: string; languages?: string[] };
  safeMode?: ResolvedSafeMode;
}) {
  return {
    id: "scrape-1",
    url: "https://example.com",
    options: {
      formats: [{ type: "markdown" }],
      skipTlsVerification: false,
      proxy: "auto",
      location,
    },
    internalOptions: {
      teamId: "team-a",
      zeroDataRetention: false,
      teamFlags,
      safeMode,
    },
    logger,
    abort: {
      scrapeTimeout: () => 30000,
      asSignal: () => undefined,
      throwIfAborted: () => {},
    },
    featureFlags: new Set(),
    mock: null,
  } as any;
}

beforeEach(() => {
  fake.calls = [];
});

describe.each([
  ["chrome-cdp", scrapeURLWithFireEngineChromeCDP],
  ["tlsclient", scrapeURLWithFireEngineTLSClient],
] as const)("fire-engine %s requests", (_, scrapeWith) => {
  const sentRequest = async (m: any) => {
    await expect(scrapeWith(m)).rejects.toBeInstanceOf(EngineError);
    const posts = fake.calls.filter(call => call.method === "POST");
    expect(posts).toHaveLength(1);
    return posts[0].body;
  };

  it("pin a US-only team to the US with country selection off", async () => {
    const body = await sentRequest(
      meta({
        teamFlags: { usOnly: true },
        location: { country: "us-generic", languages: ["en-US"] },
      }),
    );
    expect(body.geolocation).toEqual({ country: "us", languages: ["en-US"] });
    expect(body.behaviorOverrides).toEqual({ disableCountrySelection: true });
    expect(body).not.toHaveProperty("usOnly");
  });

  it("pin a US-only team without a location", async () => {
    const body = await sentRequest(meta({ teamFlags: { usOnly: true } }));
    expect(body.geolocation).toEqual({ country: "us" });
    expect(body.behaviorOverrides).toEqual({ disableCountrySelection: true });
  });

  it("keep Safe Mode's other overrides for a US-only team", async () => {
    const body = await sentRequest(
      meta({ teamFlags: { usOnly: true }, safeMode }),
    );
    expect(body.behaviorOverrides).toEqual({
      disableSiteHandling: true,
      exposeWebdriver: false,
      useHeadlessUserAgent: false,
      disablePlatformSelection: false,
      disableCountrySelection: true,
      disableAutomaticReferrer: true,
    });
  });

  it.each([undefined, { usOnly: false }])(
    "leave the request unchanged for team flags %j",
    async teamFlags => {
      const location = { country: "us-generic", languages: ["en-US"] };
      const body = await sentRequest(meta({ teamFlags, location }));
      expect(body.geolocation).toEqual(location);
      expect(body).not.toHaveProperty("behaviorOverrides");
      expect(body).not.toHaveProperty("usOnly");

      fake.calls = [];
      const withSafeMode = await sentRequest(
        meta({ teamFlags, location, safeMode }),
      );
      expect(withSafeMode.behaviorOverrides.disableCountrySelection).toBe(
        false,
      );
    },
  );
});
