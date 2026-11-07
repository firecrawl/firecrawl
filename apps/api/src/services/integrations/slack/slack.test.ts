import crypto from "crypto";
import { describe, it, expect, afterEach } from "vitest";
import { config } from "../../../config";
import { encryptSlackToken, decryptSlackToken } from "./crypto";
import { verifySlackSignature } from "./signature";
import { buildMonitorAlertMessage, escapeSlackText, slackLink } from "./messages";
import { sanitizeRedirectPath } from "./redirect";

const ORIGINAL_ENCRYPTION_KEY = config.SLACK_TOKEN_ENCRYPTION_KEY;
const ORIGINAL_SIGNING_SECRET = config.SLACK_SIGNING_SECRET;

afterEach(() => {
  config.SLACK_TOKEN_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  config.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
});

describe("slack token crypto", () => {
  it("round-trips a token with AES-256-GCM when a key is configured", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = crypto
      .randomBytes(32)
      .toString("hex");
    // Opaque placeholder — the crypto layer treats the token as bytes, and we
    // avoid real Slack bot-token shapes so secret scanners don't flag it.
    const token = "slack-bot-token-placeholder";
    const stored = encryptSlackToken(token);
    expect(stored.startsWith("gcm:")).toBe(true);
    expect(stored).not.toContain(token);
    expect(decryptSlackToken(stored)).toBe(token);
  });

  it("falls back to a plaintext marker when no key is set", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = undefined;
    const token = "self-hosted-token-placeholder";
    const stored = encryptSlackToken(token);
    expect(stored).toBe(`plain:${token}`);
    expect(decryptSlackToken(stored)).toBe(token);
  });

  it("throws when a GCM token is read without its key", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = crypto
      .randomBytes(32)
      .toString("hex");
    const stored = encryptSlackToken("bot-token-placeholder");
    config.SLACK_TOKEN_ENCRYPTION_KEY = undefined;
    expect(() => decryptSlackToken(stored)).toThrow();
  });

  it("throws on a configured-but-invalid key instead of storing plaintext", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = "invalid-key";
    expect(() => encryptSlackToken("bot-token-placeholder")).toThrow();
  });
});

describe("slack signature verification", () => {
  // Arbitrary non-secret string used only as the HMAC key for these tests.
  const secret = "test-slack-signing-secret";

  function sign(body: string, timestamp: string): string {
    return (
      "v0=" +
      crypto
        .createHmac("sha256", secret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")
    );
  }

  it("accepts a correctly signed, fresh request", () => {
    const body = "token=abc&command=%2Fmonitor&text=list";
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackSignature({
        signature: sign(body, timestamp),
        timestamp,
        rawBody: body,
        signingSecret: secret,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("original", timestamp);
    expect(
      verifySlackSignature({
        signature,
        timestamp,
        rawBody: "tampered",
        signingSecret: secret,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    const body = "text=list";
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 10);
    expect(
      verifySlackSignature({
        signature: sign(body, staleTs),
        timestamp: staleTs,
        rawBody: body,
        signingSecret: secret,
      }),
    ).toBe(false);
  });

  it("rejects when no signing secret is available", () => {
    config.SLACK_SIGNING_SECRET = undefined;
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackSignature({
        signature: "v0=deadbeef",
        timestamp,
        rawBody: "x",
      }),
    ).toBe(false);
  });
});

describe("slack link escaping", () => {
  it("percent-encodes the pipe so a URL can't spoof the display label", () => {
    // Without encoding, Slack would render this as a link to external.example labeled
    // "firecrawl.dev".
    expect(slackLink("https://external.example?x=y|firecrawl.dev")).toBe(
      "<https://external.example?x=y%7Cfirecrawl.dev>",
    );
  });

  it("strips angle brackets from the URL", () => {
    expect(slackLink("https://x.com/<a>")).toBe("<https://x.com/a>");
  });

  it("preserves the real separator for an explicit label while neutralizing URL pipes", () => {
    expect(slackLink("https://external.example?x=y|z", "Homepage")).toBe(
      "<https://external.example?x=y%7Cz|Homepage>",
    );
  });
});

describe("slack message builder", () => {
  it("escapes Slack mrkdwn control characters", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("builds an alert with a header, summary, page rows and a dashboard button", () => {
    const { text, blocks } = buildMonitorAlertMessage({
      monitorName: "Pricing <watch>",
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      checkId: "c1",
      summary: { changed: 2, new: 1, removed: 0, error: 0, totalPages: 5 },
      pages: [
        {
          url: "https://example.com/pricing",
          status: "changed",
          judgment: { meaningful: true, reason: "Price changed" },
        },
      ],
      creditsUsed: 7,
    });

    expect(text).toContain("Pricing <watch>");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("header");
    expect(serialized).toContain("View in dashboard");
    expect(serialized).toContain("example.com/pricing");
    // Header text is plain_text; the monitor name is not escaped there but the
    // fallback text keeps it readable.
    expect(serialized).toContain("meaningful");
  });

  it("bounds long page URLs so section blocks stay within Slack's 3000-char limit", () => {
    const longUrl = "https://example.com/" + "a".repeat(6000);
    const { blocks } = buildMonitorAlertMessage({
      monitorName: "m",
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      checkId: "c1",
      summary: { changed: 1, new: 0, removed: 0, error: 0, totalPages: 1 },
      pages: [
        {
          url: longUrl,
          status: "changed",
          judgment: { meaningful: true, reason: "r".repeat(500) },
        },
      ],
      creditsUsed: 1,
    });

    const sections = (blocks as Array<Record<string, any>>).filter(
      b => b.type === "section" && b.text?.type === "mrkdwn",
    );
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

describe("slack redirect sanitization", () => {
  it("allows same-origin dashboard paths", () => {
    expect(sanitizeRedirectPath("/app/monitoring/123")).toBe(
      "/app/monitoring/123",
    );
    expect(sanitizeRedirectPath("/app/monitoring?tab=slack")).toBe(
      "/app/monitoring?tab=slack",
    );
  });

  it("falls back for missing or non-absolute input", () => {
    expect(sanitizeRedirectPath(undefined)).toBe("/app/monitoring");
    expect(sanitizeRedirectPath(null)).toBe("/app/monitoring");
    expect(sanitizeRedirectPath("")).toBe("/app/monitoring");
    expect(sanitizeRedirectPath("app/monitoring")).toBe("/app/monitoring");
  });

  it("blocks open-redirect vectors", () => {
    const vectors = [
      "//external.example",
      "/\\external.example", // "/\external.example" — URL parser rewrites \ to / for http(s)
      "/\\/external.example",
      "https://external.example",
      "/\t/external.example",
      "/\n//external.example",
    ];
    for (const vector of vectors) {
      expect(sanitizeRedirectPath(vector)).toBe("/app/monitoring");
    }
  });
});
