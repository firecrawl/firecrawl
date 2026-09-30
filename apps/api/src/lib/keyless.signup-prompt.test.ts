import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the browser controller pulls in modules that open Redis clients.
vi.mock("ioredis", () => ({
  default: class {
    on() {
      return this;
    }
  },
}));
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { ttl: vi.fn().mockResolvedValue(-1), on: vi.fn() },
}));
vi.mock("./keyless", async importOriginal => {
  const actual = await importOriginal<typeof import("./keyless")>();
  return { ...actual, checkKeylessEligibility: vi.fn() };
});
vi.mock("./keyless-signup-link", async importOriginal => {
  const actual = await importOriginal<typeof import("./keyless-signup-link")>();
  return {
    ...actual,
    keylessSignupUrl: vi.fn(),
    existingKeylessSignupUrl: vi.fn(),
  };
});

import { config } from "../config";
import { keylessEligibilityController } from "../controllers/v2/keyless-eligibility";
import { browserError } from "../controllers/v2/browser";
import { HangarError } from "./hangar";
import {
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  checkKeylessEligibility,
  keylessLimitBody,
  keylessSignupUrlForIp,
  keylessTeamId,
  keylessTeamUuid,
} from "./keyless";
import {
  existingKeylessSignupUrl,
  keylessSignupUrl,
} from "./keyless-signup-link";
import { logger } from "./logger";

const OWN_LINK = "https://firecrawl.dev/k/7fq2xab9";
const TEAM_UUID = keylessTeamUuid(keylessTeamId("203.0.113.8"));

function fakeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.mocked(keylessSignupUrl).mockResolvedValue({
    url: OWN_LINK,
    shortId: "7fq2xab9",
  });
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("keyless limit prompt", () => {
  it("keeps the internal marker message on the regular signup link", () => {
    expect(KEYLESS_FREE_TIER_LIMIT_MESSAGE).toContain(
      "create a free API key at https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api\n",
    );
  });

  it("puts the caller's own link in the credit-limit body and log", async () => {
    const body = await keylessLimitBody(
      "preview_keyless_203.0.113.8",
      "v2_search",
      { body: { integration: "cli" } },
    );

    expect(keylessSignupUrl).toHaveBeenCalledWith(TEAM_UUID, "cli");
    expect(body).toMatchObject({
      success: false,
      reason: "credits",
      signup_url: OWN_LINK,
    });
    expect(body.error).toContain(`${OWN_LINK}\n`);
    expect(logger.warn).toHaveBeenCalledWith(
      "Keyless request blocked",
      expect.objectContaining({ signupRef: "7fq2xab9" }),
    );
  });

  it("uses the api surface when no request is given", async () => {
    await keylessLimitBody("preview_keyless_203.0.113.8", "v2_scrape");
    expect(keylessSignupUrl).toHaveBeenCalledWith(TEAM_UUID, "api");
  });

  it("keys IPv4-mapped IPv6 on the IPv4 identity and issues nothing for other IPs", async () => {
    await keylessSignupUrlForIp("::ffff:203.0.113.8", "mcp");
    expect(keylessSignupUrl).toHaveBeenLastCalledWith(TEAM_UUID, "mcp");
    await keylessSignupUrlForIp("2001:db8::1", "mcp");
    expect(keylessSignupUrl).toHaveBeenLastCalledWith(null, "mcp");
    await keylessSignupUrlForIp("unknown", "api");
    expect(keylessSignupUrl).toHaveBeenLastCalledWith(null, "api");
  });
});

describe("browserError", () => {
  it("replaces the keyless browser limit text with the caller's own link", async () => {
    const res = fakeRes();
    await browserError(
      res,
      new HangarError(429, KEYLESS_FREE_TIER_LIMIT_MESSAGE),
      {
        auth: { team_id: "preview_keyless_203.0.113.8" },
        body: { origin: "cli" },
        headers: {},
      } as any,
    );

    expect(keylessSignupUrl).toHaveBeenCalledWith(TEAM_UUID, "cli");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: expect.stringContaining(OWN_LINK),
      signup_url: OWN_LINK,
    });
  });

  it("leaves other browser errors unchanged", async () => {
    const res = fakeRes();
    await browserError(res, new HangarError(409, "Session closed."), {
      auth: { team_id: "preview_keyless_203.0.113.8" },
    } as any);

    expect(keylessSignupUrl).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Session closed.",
    });
  });
});

describe("keyless eligibility signup link", () => {
  const originalSecret = config.KEYLESS_PROXY_SECRET;
  beforeEach(() => {
    config.KEYLESS_PROXY_SECRET = "proxy-secret";
  });
  afterEach(() => {
    config.KEYLESS_PROXY_SECRET = originalSecret;
  });

  const eligibilityRequest = (query: Record<string, string> = {}) =>
    ({
      headers: {
        "x-firecrawl-keyless-secret": "proxy-secret",
        "x-firecrawl-keyless-ip": "203.0.113.8",
      },
      query,
    }) as any;

  it.each(["requests", "credits"] as const)(
    "links an identity refused for %s to its own mcp link",
    async reason => {
      vi.mocked(checkKeylessEligibility).mockResolvedValue({
        eligible: false,
        reason,
      });
      const res = fakeRes();

      await keylessEligibilityController(eligibilityRequest(), res);

      expect(keylessSignupUrl).toHaveBeenCalledWith(TEAM_UUID, "mcp");
      // Refusals stay 200 so the MCP serves structured recovery, not a challenge.
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        eligible: false,
        reason,
        signupUrl: OWN_LINK,
      });
    },
  );

  it("only reuses an existing link for a suspicious refusal, never issuing", async () => {
    vi.mocked(checkKeylessEligibility).mockResolvedValue({
      eligible: false,
      reason: "suspicious",
    });
    vi.mocked(existingKeylessSignupUrl).mockResolvedValue({
      url: OWN_LINK,
      shortId: "7fq2xab9",
    });
    const res = fakeRes();

    await keylessEligibilityController(eligibilityRequest(), res);

    expect(keylessSignupUrl).not.toHaveBeenCalled();
    expect(existingKeylessSignupUrl).toHaveBeenCalledWith(TEAM_UUID, "mcp");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      eligible: false,
      reason: "suspicious",
      signupUrl: OWN_LINK,
    });
  });

  it.each(["disabled", "error"] as const)(
    "gives the regular signup link without issuing when the refusal is %s",
    async reason => {
      vi.mocked(checkKeylessEligibility).mockResolvedValue({
        eligible: false,
        reason,
      });
      const res = fakeRes();

      await keylessEligibilityController(eligibilityRequest(), res);

      expect(keylessSignupUrl).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        eligible: false,
        reason,
        signupUrl:
          "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=mcp",
      });
    },
  );

  it("omits the link for an eligible IP unless asked", async () => {
    vi.mocked(checkKeylessEligibility).mockResolvedValue({ eligible: true });
    const res = fakeRes();

    await keylessEligibilityController(eligibilityRequest(), res);
    await keylessEligibilityController(
      eligibilityRequest({ signup_link: "1" }),
      res,
    );

    expect(res.status.mock.calls).toEqual([[200], [200]]);
    expect(res.json.mock.calls).toEqual([
      [{ eligible: true }],
      [{ eligible: true, signupUrl: OWN_LINK }],
    ]);
  });
});
