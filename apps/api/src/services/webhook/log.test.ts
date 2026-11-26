import { describe, expect, it } from "vitest";
import { summarizeWebhookForLog, withWebhookSummaryForLog } from "./log";

describe("summarizeWebhookForLog", () => {
  it("keeps only host, events and header count from a config object", () => {
    const summary = summarizeWebhookForLog({
      url: "https://user:pw@hooks.example.com:8443/path/xyz?sig=abc",
      headers: { Authorization: "Bearer abc", "X-Key": "abc" },
      metadata: { key: "abc" },
      events: ["completed", "page"],
    });

    expect(summary).toEqual({
      host: "hooks.example.com:8443",
      events: ["completed", "page"],
      headerCount: 2,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("abc");
    expect(serialized).not.toContain("xyz");
    expect(serialized).not.toContain("pw");
  });

  it("handles a bare URL string", () => {
    expect(
      summarizeWebhookForLog("https://hooks.example.com/hook?sig=abc"),
    ).toEqual({ host: "hooks.example.com", headerCount: 0 });
  });

  it("returns a null host for an unparseable URL", () => {
    expect(summarizeWebhookForLog({ url: "not a url?sig=abc" })).toEqual({
      host: null,
      events: undefined,
      headerCount: 0,
    });
  });

  it("returns undefined when there is no webhook", () => {
    expect(summarizeWebhookForLog(undefined)).toBeUndefined();
    expect(summarizeWebhookForLog(null)).toBeUndefined();
  });
});

describe("withWebhookSummaryForLog", () => {
  it("replaces only the webhook field", () => {
    const body = {
      url: "https://example.com",
      limit: 10,
      webhook: {
        url: "https://hooks.example.com/hook?sig=abc",
        headers: { Authorization: "Bearer abc" },
      },
    };

    const summarized = withWebhookSummaryForLog(body);

    expect(summarized).toEqual({
      url: "https://example.com",
      limit: 10,
      webhook: { host: "hooks.example.com", events: undefined, headerCount: 1 },
    });
    expect(body.webhook.headers.Authorization).toBe("Bearer abc");
  });

  it("returns bodies without a webhook unchanged", () => {
    const body = { url: "https://example.com" };
    expect(withWebhookSummaryForLog(body)).toBe(body);
    expect(withWebhookSummaryForLog(undefined)).toBeUndefined();
  });
});
