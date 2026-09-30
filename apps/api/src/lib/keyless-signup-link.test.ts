import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { logger } from "./logger";
import {
  type KeylessPromptReason,
  type KeylessSignupSurface,
  decryptKeylessSignupToken,
  encryptKeylessSignupToken,
  ff1Decrypt,
  ff1Encrypt,
  keylessFallbackSignupUrl,
  keylessSignupLink,
  keylessSignupSurface,
} from "./keyless-signup-link";

// Shared with firecrawl-web lib/keyless-signup-link.test.ts: both repos must
// produce and accept exactly this token for this key and payload.
const CROSS_REPO_KEY = "AAECAwQFBgcICQoLDA0ODw==";
const CROSS_REPO_PAYLOAD = {
  ipv4: "203.0.113.8",
  surface: "mcp",
  reason: "limit",
} as const;
const CROSS_REPO_TOKEN = "hrxch5c20tcs";

const KEY = Buffer.from(CROSS_REPO_KEY, "base64");
const OTHER_KEY = Buffer.alloc(16, 7);
const TOKEN_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

describe("FF1 (NIST SP 800-38G AES-128 samples)", () => {
  const key = Buffer.from("2B7E151628AED2A6ABF7158809CF4F3C", "hex");
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const toNumerals = (s: string) => [...s].map(c => alphabet.indexOf(c));
  const fromNumerals = (n: number[]) => n.map(d => alphabet[d]).join("");

  it.each([
    ["sample 1", 10, "", "0123456789", "2433477484"],
    ["sample 2", 10, "39383736353433323130", "0123456789", "6124200773"],
    [
      "sample 3",
      36,
      "3737373770717273373737",
      "0123456789abcdefghi",
      "a9tv40mll9kdu509eum",
    ],
  ] as const)("%s", (_name, radix, tweakHex, plaintext, ciphertext) => {
    const tweak = Buffer.from(tweakHex, "hex");
    expect(
      fromNumerals(ff1Encrypt(key, tweak, radix, toNumerals(plaintext))),
    ).toBe(ciphertext);
    expect(
      fromNumerals(ff1Decrypt(key, tweak, radix, toNumerals(ciphertext))),
    ).toBe(plaintext);
  });
});

describe("keyless signup token", () => {
  it("matches the cross-repo vector", () => {
    expect(encryptKeylessSignupToken(CROSS_REPO_PAYLOAD, KEY)).toBe(
      CROSS_REPO_TOKEN,
    );
    expect(decryptKeylessSignupToken(CROSS_REPO_TOKEN, [KEY])).toEqual(
      CROSS_REPO_PAYLOAD,
    );
  });

  const surfaces: KeylessSignupSurface[] = ["api", "mcp", "cli"];
  const reasons: KeylessPromptReason[] = [
    "limit",
    "account_only_tool",
    "unsupported_endpoint",
    "suspicious_ip",
  ];
  it.each(
    surfaces.flatMap(surface => reasons.map(reason => [surface, reason])),
  )("round-trips surface %s and reason %s", (surface, reason) => {
    for (const ipv4 of ["0.0.0.0", "203.0.113.8", "255.255.255.255"]) {
      const payload = {
        ipv4,
        surface: surface as KeylessSignupSurface,
        reason: reason as KeylessPromptReason,
      };
      const token = encryptKeylessSignupToken(payload, KEY);
      expect(token).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
      expect(decryptKeylessSignupToken(token!, [KEY])).toEqual(payload);
    }
  });

  it("rejects every single-character change to a token", () => {
    for (let i = 0; i < CROSS_REPO_TOKEN.length; i++) {
      for (const c of TOKEN_ALPHABET) {
        if (c === CROSS_REPO_TOKEN[i]) continue;
        const tampered =
          CROSS_REPO_TOKEN.slice(0, i) + c + CROSS_REPO_TOKEN.slice(i + 1);
        expect(decryptKeylessSignupToken(tampered, [KEY])).toBeNull();
      }
    }
  });

  it.each([
    "",
    "hrxch5c20tc",
    "hrxch5c20tcss",
    "HRXCH5C20TCS",
    "hrxch5c20tci",
    "hrxch5c20tc/",
  ])("rejects the malformed token %j", token => {
    expect(decryptKeylessSignupToken(token, [KEY])).toBeNull();
  });

  it("decrypts a token from a rotated-out key while it stays listed", () => {
    const oldToken = encryptKeylessSignupToken(CROSS_REPO_PAYLOAD, OTHER_KEY)!;
    expect(decryptKeylessSignupToken(oldToken, [KEY])).toBeNull();
    expect(decryptKeylessSignupToken(oldToken, [KEY, OTHER_KEY])).toEqual(
      CROSS_REPO_PAYLOAD,
    );
    expect(
      decryptKeylessSignupToken(CROSS_REPO_TOKEN, [KEY, OTHER_KEY]),
    ).toEqual(CROSS_REPO_PAYLOAD);
  });

  it("shows no IP bytes in the clear", () => {
    // The unencrypted numerals of the IP, and the IP in hex or decimal.
    const ipNumerals = (
      (((203n << 24n) | (0n << 16n) | (113n << 8n) | 8n) << 28n) >>
      25n
    )
      .toString(32)
      .padStart(7, "0");
    const token = encryptKeylessSignupToken(CROSS_REPO_PAYLOAD, KEY)!;
    expect(token.slice(0, 7)).not.toBe(ipNumerals);
    for (const clear of ["cb007108", "203", "113", "cb", "71"]) {
      expect(token).not.toContain(clear);
    }
    // Neighbouring IPs give unrelated tokens.
    const next = encryptKeylessSignupToken(
      { ...CROSS_REPO_PAYLOAD, ipv4: "203.0.113.9" },
      KEY,
    )!;
    const shared = [...token].filter((c, i) => next[i] === c).length;
    expect(shared).toBeLessThan(6);
  });

  it("gives no token for a non-IPv4 identity", () => {
    for (const ipv4 of ["2001:db8::1", "::ffff:203.0.113.8", "unknown", ""]) {
      expect(
        encryptKeylessSignupToken({ ...CROSS_REPO_PAYLOAD, ipv4 }, KEY),
      ).toBeUndefined();
    }
  });
});

describe("keylessSignupLink", () => {
  const originalKeys = config.KEYLESS_SIGNUP_LINK_KEYS;
  beforeEach(() => {
    config.KEYLESS_SIGNUP_LINK_KEYS = CROSS_REPO_KEY;
  });
  afterEach(() => {
    config.KEYLESS_SIGNUP_LINK_KEYS = originalKeys;
  });

  it("builds a clean /k/<token> link with no query string", () => {
    expect(keylessSignupLink("203.0.113.8", "mcp", "limit")).toEqual({
      url: `https://firecrawl.dev/k/${CROSS_REPO_TOKEN}`,
      signupRef: CROSS_REPO_TOKEN,
    });
  });

  it("encrypts with the first key and decrypts with any listed key", () => {
    config.KEYLESS_SIGNUP_LINK_KEYS = `${OTHER_KEY.toString("base64")}, ${CROSS_REPO_KEY}`;
    const { signupRef } = keylessSignupLink("203.0.113.8", "mcp", "limit");
    expect(signupRef).not.toBe(CROSS_REPO_TOKEN);
    expect(decryptKeylessSignupToken(signupRef!, [OTHER_KEY])).toEqual(
      CROSS_REPO_PAYLOAD,
    );
    expect(decryptKeylessSignupToken(CROSS_REPO_TOKEN)).toEqual(
      CROSS_REPO_PAYLOAD,
    );
  });

  it.each([undefined, "", "not-a-key", "AAECAwQFBgcICQoLDA0O"])(
    "gives the regular signup link when the keys are %j",
    keys => {
      const warn = vi.spyOn(logger, "warn");
      config.KEYLESS_SIGNUP_LINK_KEYS = keys;
      expect(keylessSignupLink("203.0.113.8", "cli", "limit")).toEqual({
        url: keylessFallbackSignupUrl("cli"),
      });
      // A missing key is a plain fallback, not a caught failure.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it.each([null, undefined, "", "2001:db8::1", "unknown"])(
    "gives the regular signup link for the non-IPv4 identity %j",
    ip => {
      expect(keylessSignupLink(ip, "api", "unsupported_endpoint")).toEqual({
        url: "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api",
      });
    },
  );
});

describe("keylessSignupSurface", () => {
  const originalSecret = config.KEYLESS_PROXY_SECRET;
  afterEach(() => {
    config.KEYLESS_PROXY_SECRET = originalSecret;
  });

  it.each([
    [{ body: { integration: "cli" } }, "cli"],
    [{ body: { origin: "cli" } }, "cli"],
    [{ body: {}, headers: { "x-origin": "cli" } }, "cli"],
    [{ body: { origin: "mcp-claude-code@3.24.1" } }, "mcp"],
    [{ body: {}, headers: { "x-origin": "mcp-fastmcp@3.24.1" } }, "mcp"],
    [{ body: { origin: "api" } }, "api"],
    [{ body: { origin: "js-sdk@4.3.0" } }, "api"],
    [{ body: { origin: "website" } }, "api"],
    [{ body: {} }, "api"],
    [{}, "api"],
    // Case-insensitive, like the warehouse classifier.
    [{ body: { origin: "CLI" } }, "cli"],
    [{ body: { integration: "Cli" } }, "cli"],
    [{ body: { origin: "MCP-Claude-Code@3.24.1" } }, "mcp"],
    [{ body: {}, headers: { "x-origin": "MCP-fastmcp@3.24.1" } }, "mcp"],
    // v1 schemas prefault a missing origin to "api"; the header still counts.
    [{ body: { origin: "api" }, headers: { "x-origin": "cli" } }, "cli"],
    [{ body: { origin: "api" }, headers: { "x-origin": "mcp-x@1" } }, "mcp"],
    // An explicit non-default body origin still wins over the header.
    [
      { body: { origin: "js-sdk@4.3.0" }, headers: { "x-origin": "cli" } },
      "api",
    ],
  ] as const)("classifies %j as %s", (req, surface) => {
    expect(keylessSignupSurface(req as never)).toBe(surface);
  });

  it("treats a request relayed with the proxy secret as MCP", () => {
    config.KEYLESS_PROXY_SECRET = "proxy-secret";
    expect(
      keylessSignupSurface({
        body: { origin: "api" },
        headers: { "x-firecrawl-keyless-secret": "proxy-secret" },
      }),
    ).toBe("mcp");
    expect(
      keylessSignupSurface({
        body: { origin: "api" },
        headers: { "x-firecrawl-keyless-secret": "wrong" },
      }),
    ).toBe("api");
  });
});
