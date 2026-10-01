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
vi.mock("./keyless-prompt-analytics", () => ({
  trackKeylessPromptShown: vi.fn(),
}));
vi.mock("./keyless", async importOriginal => {
  const actual = await importOriginal<typeof import("./keyless")>();
  return { ...actual, checkKeylessEligibility: vi.fn() };
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
  reportKeylessPromptShown,
} from "./keyless";
import { trackKeylessPromptShown } from "./keyless-prompt-analytics";
import { decryptKeylessSignupToken } from "./keyless-signup-link";
import { logger } from "./logger";

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODw==";
const IP = "203.0.113.8";
const TEAM_UUID = "abd15a03-d147-557e-801b-005da8c69bbf";

/** The prompt reported to analytics, with its defaults for IP. */
function shown(fields: Partial<Parameters<typeof trackKeylessPromptShown>[0]>) {
  return {
    keylessTeamId: TEAM_UUID,
    tokenLink: true,
    ...fields,
  };
}

/** The prompt a /k link carries, or null for any other link. */
function decoded(url: unknown) {
  const match = /^https:\/\/firecrawl\.dev\/k\/([0-9a-z]{12})$/.exec(
    String(url),
  );
  return match ? decryptKeylessSignupToken(match[1]) : null;
}

function fakeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

const originalKeys = config.KEYLESS_SIGNUP_LINK_KEYS;
beforeEach(() => {
  config.KEYLESS_SIGNUP_LINK_KEYS = TEST_KEY;
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

afterEach(() => {
  config.KEYLESS_SIGNUP_LINK_KEYS = originalKeys;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("keylessTeamUuid", () => {
  it("matches the cross-repo vector in firecrawl-web lib/keyless-signup-link.test.ts", () => {
    expect(keylessTeamUuid(keylessTeamId(IP))).toBe(
      "abd15a03-d147-557e-801b-005da8c69bbf",
    );
  });
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

    expect(decoded(body.signup_url)).toEqual({
      ipv4: IP,
      surface: "cli",
      reason: "limit",
    });
    expect(body).toMatchObject({ success: false, reason: "credits" });
    expect(body.error).toContain(`${body.signup_url}\n`);
    expect(logger.warn).toHaveBeenCalledWith(
      "Keyless request blocked",
      expect.objectContaining({
        signupRef: body.signup_url.split("/k/")[1],
      }),
    );
    expect(trackKeylessPromptShown).toHaveBeenCalledExactlyOnceWith(
      shown({ surface: "cli", reason: "limit", httpStatus: 429 }),
    );
  });

  it("uses the api surface when no request is given", async () => {
    const body = await keylessLimitBody(
      "preview_keyless_203.0.113.8",
      "v2_scrape",
    );
    expect(decoded(body.signup_url)?.surface).toBe("api");
  });

  it("gives the regular signup link when no key is configured", async () => {
    config.KEYLESS_SIGNUP_LINK_KEYS = undefined;
    const body = await keylessLimitBody(
      "preview_keyless_203.0.113.8",
      "v2_scrape",
      { body: { origin: "mcp-cursor@1" } },
    );
    expect(body.signup_url).toBe(
      "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=mcp",
    );
    expect(body.error).toContain(`${body.signup_url}\n`);
    expect(trackKeylessPromptShown).toHaveBeenCalledExactlyOnceWith(
      shown({
        surface: "mcp",
        reason: "limit",
        httpStatus: 429,
        tokenLink: false,
      }),
    );
  });

  it("keys IPv4-mapped IPv6 on the IPv4 identity and gives other IPs the regular link", () => {
    expect(
      decoded(keylessSignupUrlForIp("::ffff:203.0.113.8", "mcp", "limit").url),
    ).toEqual({ ipv4: IP, surface: "mcp", reason: "limit" });
    expect(keylessSignupUrlForIp("2001:db8::1", "mcp", "limit")).toEqual({
      url: "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=mcp",
    });
    expect(keylessSignupUrlForIp("unknown", "api", "limit")).toEqual({
      url: "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api",
    });
  });
});

describe("reportKeylessPromptShown", () => {
  it("reports an IPv4-mapped IPv6 caller under the IPv4 team id", () => {
    reportKeylessPromptShown("::ffff:203.0.113.8", "api", "limit", 429, "ref");
    expect(trackKeylessPromptShown).toHaveBeenCalledExactlyOnceWith(
      shown({ surface: "api", reason: "limit", httpStatus: 429 }),
    );
  });

  it.each([null, undefined, "", "unknown", "2001:db8::1"])(
    "does not report a caller without a keyless identity (%j)",
    ip => {
      reportKeylessPromptShown(ip, "api", "limit", 429);
      expect(trackKeylessPromptShown).not.toHaveBeenCalled();
    },
  );
});

describe("browserError", () => {
  it("replaces the keyless browser limit text with the caller's own link", () => {
    const res = fakeRes();
    browserError(res, new HangarError(429, KEYLESS_FREE_TIER_LIMIT_MESSAGE), {
      auth: { team_id: "preview_keyless_203.0.113.8" },
      body: { origin: "cli" },
      headers: {},
    } as any);

    expect(res.status).toHaveBeenCalledWith(429);
    const body = res.json.mock.calls[0][0];
    expect(decoded(body.signup_url)).toEqual({
      ipv4: IP,
      surface: "cli",
      reason: "limit",
    });
    expect(body).toEqual({
      success: false,
      error: expect.stringContaining(`${body.signup_url}\n`),
      signup_url: body.signup_url,
    });
    expect(trackKeylessPromptShown).toHaveBeenCalledExactlyOnceWith(
      shown({ surface: "cli", reason: "limit", httpStatus: 429 }),
    );
  });

  it("leaves other browser errors unchanged", () => {
    const res = fakeRes();
    browserError(res, new HangarError(409, "Session closed."), {
      auth: { team_id: "preview_keyless_203.0.113.8" },
    } as any);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Session closed.",
    });
    expect(trackKeylessPromptShown).not.toHaveBeenCalled();
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

  const eligibilityRequest = (query: Record<string, string> = {}, ip = IP) =>
    ({
      headers: {
        "x-firecrawl-keyless-secret": "proxy-secret",
        "x-firecrawl-keyless-ip": ip,
      },
      query,
    }) as any;

  const MCP_FALLBACK =
    "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=mcp";

  it.each([
    ["requests", "limit"],
    ["credits", "limit"],
    ["suspicious", "suspicious_ip"],
  ] as const)(
    "links an identity refused for %s to its own mcp link tagged %s",
    async (refusal, reason) => {
      vi.mocked(checkKeylessEligibility).mockResolvedValue({
        eligible: false,
        reason: refusal,
      });
      const res = fakeRes();

      await keylessEligibilityController(eligibilityRequest(), res);

      // Refusals stay 200 so the MCP serves structured recovery, not a challenge.
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).toEqual({
        eligible: false,
        reason: refusal,
        signupUrl: expect.any(String),
      });
      expect(decoded(body.signupUrl)).toEqual({
        ipv4: IP,
        surface: "mcp",
        reason,
      });
      // The MCP relays the link as the prompt, so the check reports it.
      expect(trackKeylessPromptShown).toHaveBeenCalledExactlyOnceWith(
        shown({ surface: "mcp", reason, httpStatus: 200 }),
      );
    },
  );

  it("gives a suspicious refusal the regular mcp link when no key is configured", async () => {
    config.KEYLESS_SIGNUP_LINK_KEYS = undefined;
    vi.mocked(checkKeylessEligibility).mockResolvedValue({
      eligible: false,
      reason: "suspicious",
    });
    const res = fakeRes();

    await keylessEligibilityController(eligibilityRequest(), res);

    expect(res.json).toHaveBeenCalledWith({
      eligible: false,
      reason: "suspicious",
      signupUrl: MCP_FALLBACK,
    });
  });

  it.each(["disabled", "error"] as const)(
    "gives the regular signup link when the refusal is %s",
    async reason => {
      vi.mocked(checkKeylessEligibility).mockResolvedValue({
        eligible: false,
        reason,
      });
      const res = fakeRes();

      await keylessEligibilityController(eligibilityRequest(), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        eligible: false,
        reason,
        signupUrl: MCP_FALLBACK,
      });
      expect(trackKeylessPromptShown).not.toHaveBeenCalled();
    },
  );

  it("gives a non-IPv4 caller the regular signup link", async () => {
    vi.mocked(checkKeylessEligibility).mockResolvedValue({
      eligible: false,
      reason: "ineligible_ip",
    });
    const res = fakeRes();

    await keylessEligibilityController(
      eligibilityRequest({ signup_link: "1" }, "2001:db8::1"),
      res,
    );

    expect(res.json).toHaveBeenCalledWith({
      eligible: false,
      reason: "ineligible_ip",
      signupUrl: MCP_FALLBACK,
    });
    // An IPv6 caller is not a keyless identity, so nothing is reported.
    expect(trackKeylessPromptShown).not.toHaveBeenCalled();
  });

  it("omits the link for an eligible IP unless asked", async () => {
    vi.mocked(checkKeylessEligibility).mockResolvedValue({ eligible: true });
    const res = fakeRes();

    await keylessEligibilityController(eligibilityRequest(), res);
    await keylessEligibilityController(
      eligibilityRequest({ signup_link: "1" }),
      res,
    );

    expect(res.status.mock.calls).toEqual([[200], [200]]);
    expect(res.json.mock.calls[0]).toEqual([{ eligible: true }]);
    // Only the asked-for account-only link is a prompt.
    expect(trackKeylessPromptShown).toHaveBeenCalledExactlyOnceWith(
      shown({ surface: "mcp", reason: "account_only_tool", httpStatus: 200 }),
    );
    const asked = res.json.mock.calls[1][0];
    expect(asked).toEqual({ eligible: true, signupUrl: expect.any(String) });
    expect(decoded(asked.signupUrl)).toEqual({
      ipv4: IP,
      surface: "mcp",
      reason: "account_only_tool",
    });
  });

  it("tags the account-only link with that reason even when the IP is also refused", async () => {
    vi.mocked(checkKeylessEligibility).mockResolvedValue({
      eligible: false,
      reason: "credits",
    });
    const res = fakeRes();

    await keylessEligibilityController(
      eligibilityRequest({ signup_link: "1" }),
      res,
    );

    expect(decoded(res.json.mock.calls[0][0].signupUrl)?.reason).toBe(
      "account_only_tool",
    );
  });
});
