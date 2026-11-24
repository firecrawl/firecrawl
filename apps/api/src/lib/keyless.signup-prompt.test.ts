import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ioredis", () => ({
  default: class {
    on() {
      return this;
    }
  },
}));
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { pttl: vi.fn().mockResolvedValue(-1), on: vi.fn() },
}));
vi.mock("./keyless-prompt-analytics", () => ({
  trackKeylessPromptShown: vi.fn(),
}));

import { config } from "../config";
import {
  KEYLESS_FREE_TIER_LIMIT_MESSAGE,
  keylessLimitBody,
  keylessProviderToolsBody,
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

describe("keyless provider tools prompt", () => {
  it("puts the caller's own link in the refusal and reports it", () => {
    const body = keylessProviderToolsBody("preview_keyless_203.0.113.8", {
      body: { origin: "cli" },
    });

    expect(decoded(body.signup_url)).toEqual({
      ipv4: IP,
      surface: "cli",
      reason: "account_only_tool",
    });
    expect(body).toEqual({
      success: false,
      error: expect.stringMatching(
        /^An API key is required for provider tools\. /,
      ),
      signup_url: body.signup_url,
    });
    expect(body.error).toContain(`${body.signup_url}\n`);
    expect(trackKeylessPromptShown).toHaveBeenCalledExactlyOnceWith(
      shown({ surface: "cli", reason: "account_only_tool", httpStatus: 403 }),
    );
  });

  it("gives a World ID caller the regular signup link and reports nothing", () => {
    const body = keylessProviderToolsBody(
      `preview_keyless_wid_${"h".repeat(43)}`,
      {
        body: {},
      },
    );

    expect(body.signup_url).toBe(
      "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api",
    );
    expect(body.error).toContain(`${body.signup_url}\n`);
    expect(trackKeylessPromptShown).not.toHaveBeenCalled();
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
