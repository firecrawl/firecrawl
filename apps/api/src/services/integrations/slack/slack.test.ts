import crypto from "crypto";
import { describe, it, expect, afterEach } from "vitest";
import { config } from "../../../config";
import { encryptSlackToken, decryptSlackToken } from "./crypto";
import { verifySlackSignature } from "./signature";
import {
  buildMonitorAlertMessage,
  escapeSlackText,
  slackLink,
} from "./messages";
import { sanitizeRedirectPath } from "./redirect";

const ORIGINAL_ENCRYPTION_KEY = config.SLACK_TOKEN_ENCRYPTION_KEY;
const ORIGINAL_SIGNING_SECRET = config.SLACK_SIGNING_SECRET;

afterEach(() => {
  config.SLACK_TOKEN_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  config.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
});

describe("slack token crypto", () => {
  it("round-trips a token with AES-256-GCM when a key is configured", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
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
    config.SLACK_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
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

  it("builds an alert with Monitor + Check in header, goal in italics, URL above description, and a dashboard button", () => {
    const { text, blocks } = buildMonitorAlertMessage({
      monitorName: "Pricing <watch>",
      monitorGoal: "Alert when the pricing page changes.",
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      monitorUrl: "https://www.firecrawl.dev/app/monitoring/m1",
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

    // Fallback text includes Monitor + check ID.
    expect(text).toContain("Monitor Pricing <watch>");
    expect(text).toContain("check c1");

    const typedBlocks = blocks as Array<Record<string, any>>;
    const serialized = JSON.stringify(blocks);

    // Header includes "Monitor" and the check ID.
    expect(serialized).toContain("Monitor Pricing");
    expect(serialized).toContain("Check c1");

    // Goal block: second block, is a section with italic-wrapped link to
    // monitorUrl (not dashboardUrl) and the goal text as the label.
    const goalBlock = typedBlocks[1];
    expect(goalBlock.type).toBe("section");
    expect(goalBlock.text?.type).toBe("mrkdwn");
    const goalMrkdwn = goalBlock.text.text as string;
    // Italics markers present.
    expect(goalMrkdwn.startsWith("_")).toBe(true);
    expect(goalMrkdwn.endsWith("_")).toBe(true);
    // Links to monitorUrl specifically (not dashboardUrl with ?checkId=).
    expect(goalMrkdwn).toContain(
      "<https://www.firecrawl.dev/app/monitoring/m1|",
    );
    expect(goalMrkdwn).not.toContain("checkId=c1");
    // Goal text is the link label (escaped by slackLink, not double-escaped).
    expect(goalMrkdwn).toContain("Alert when the pricing page changes.");

    // URL appears before the description in the blocks order.
    const urlIdx = serialized.indexOf("example.com/pricing");
    const descIdx = serialized.indexOf("Price changed");
    expect(urlIdx).toBeGreaterThan(-1);
    expect(descIdx).toBeGreaterThan(-1);
    expect(urlIdx).toBeLessThan(descIdx);

    // Per-page section includes bolded status text.
    const pageSection = typedBlocks.find(
      b =>
        b.type === "section" && b.text?.text?.includes("example.com/pricing"),
    );
    expect(pageSection).toBeDefined();
    expect(pageSection!.text.text).toContain("*changed*");

    // Dashboard button present.
    expect(serialized).toContain("View in dashboard");

    // Meaningful tag present.
    expect(serialized).toContain("meaningful");
  });

  it("omits the goal section when no goal is set", () => {
    const { blocks } = buildMonitorAlertMessage({
      monitorName: "m",
      monitorGoal: null,
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      monitorUrl: "https://www.firecrawl.dev/app/monitoring/m1",
      checkId: "c1",
      summary: { changed: 1, new: 0, removed: 0, error: 0, totalPages: 1 },
      pages: [
        {
          url: "https://example.com",
          status: "changed",
          judgment: { meaningful: true, reason: "r" },
        },
      ],
      creditsUsed: 1,
    });
    // Header is first, then the first section should be the page URL — no goal section.
    const typedBlocks = blocks as Array<Record<string, any>>;
    expect(typedBlocks[0].type).toBe("header");
    // The next block should not be a goal section — it should be the page URL section.
    const second = typedBlocks[1];
    expect(second.type).toBe("section");
    expect(second.text?.text).not.toContain("monitoring/m1|");
  });

  it("truncates long monitor goals to ≤ MAX_GOAL_LEN with ellipsis", () => {
    const longGoal = "g".repeat(300);
    const { blocks } = buildMonitorAlertMessage({
      monitorName: "m",
      monitorGoal: longGoal,
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      monitorUrl: "https://www.firecrawl.dev/app/monitoring/m1",
      checkId: "c1",
      summary: { changed: 1, new: 0, removed: 0, error: 0, totalPages: 1 },
      pages: [
        {
          url: "https://example.com",
          status: "changed",
          judgment: { meaningful: true, reason: "r" },
        },
      ],
      creditsUsed: 1,
    });
    const typedBlocks = blocks as Array<Record<string, any>>;
    const goalBlock = typedBlocks[1];
    expect(goalBlock.type).toBe("section");
    const goalMrkdwn = goalBlock.text.text as string;
    // The label inside <url|label> should be truncated to 200 chars (including
    // the trailing ellipsis that truncate() adds).
    const labelMatch = goalMrkdwn.match(/\|([^>]+)>/);
    expect(labelMatch).toBeDefined();
    const label = labelMatch![1];
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label).toMatch(/…$/);
  });

  it("truncates long change descriptions to keep the alert compact", () => {
    const longReason = "r".repeat(500);
    const { blocks } = buildMonitorAlertMessage({
      monitorName: "m",
      monitorGoal: null,
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      monitorUrl: "https://www.firecrawl.dev/app/monitoring/m1",
      checkId: "c1",
      summary: { changed: 1, new: 0, removed: 0, error: 0, totalPages: 1 },
      pages: [
        {
          url: "https://example.com",
          status: "changed",
          judgment: { meaningful: true, reason: longReason },
        },
      ],
      creditsUsed: 1,
    });
    // The description context block should be truncated (≤ 280 + ellipsis).
    const contextBlocks = (blocks as Array<Record<string, any>>).filter(
      b => b.type === "context",
    );
    const descBlock = contextBlocks.find(b =>
      b.elements?.some((e: any) => e.text?.includes("r".repeat(50))),
    );
    expect(descBlock).toBeDefined();
    const descText = descBlock!.elements[0].text;
    expect(descText.length).toBeLessThanOrEqual(280);
  });

  it("bounds long page URLs so section blocks stay within Slack's 3000-char limit", () => {
    const longUrl = "https://example.com/" + "a".repeat(6000);
    const { blocks } = buildMonitorAlertMessage({
      monitorName: "m",
      monitorGoal: null,
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      monitorUrl: "https://www.firecrawl.dev/app/monitoring/m1",
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
