import { REDACTED, redactLogData } from "./redact";

describe("redactLogData", () => {
  it("replaces header values under any spelling and keeps the names", () => {
    const row = redactLogData({
      options: {
        headers: {
          Authorization: "Bearer secret",
          cookie: "session=abc",
          "X-Api-Key": "key",
          "Accept-Language": "en",
        },
      },
    });

    expect(row.options.headers).toEqual({
      Authorization: REDACTED,
      cookie: REDACTED,
      "X-Api-Key": REDACTED,
      "Accept-Language": REDACTED,
    });
  });

  it("redacts webhook headers nested inside crawl options", () => {
    const row = redactLogData({
      options: {
        scrapeOptions: { formats: ["markdown"] },
        webhook: {
          url: "https://hooks.example/firecrawl",
          headers: { Authorization: "Bearer hook-secret" },
          metadata: { env: "prod" },
        },
      },
    });

    expect(row.options.webhook.url).toBe("https://hooks.example/firecrawl");
    expect(row.options.webhook.headers).toEqual({ Authorization: REDACTED });
    expect(row.options.webhook.metadata).toEqual({ env: "prod" });
  });

  it("drops internal double-underscore fields at every depth", () => {
    const row = redactLogData({
      options: {
        formats: ["markdown"],
        __searchPreviewToken: "preview-token",
        __agentInterop: { auth: "s2s-secret", requestId: "r1" },
        scrapeOptions: { __forceFirePDF: true, onlyMainContent: true },
      },
    });

    expect(row.options).toEqual({
      formats: ["markdown"],
      scrapeOptions: { onlyMainContent: true },
    });
  });

  it("redacts the text of write actions and nothing else about them", () => {
    const row = redactLogData({
      options: {
        actions: [
          { type: "click", selector: "#login" },
          {
            type: "write",
            text: "hunter2",
            selector: "#password",
            __internal: "flag",
            headers: { Authorization: "Bearer x" },
          },
          { type: "wait", milliseconds: 500 },
        ],
      },
    });

    expect(row.options.actions).toEqual([
      { type: "click", selector: "#login" },
      {
        type: "write",
        text: REDACTED,
        selector: "#password",
        headers: { Authorization: REDACTED },
      },
      { type: "wait", milliseconds: 500 },
    ]);
  });

  it("leaves non-header objects named headers alone", () => {
    const row = redactLogData({ headers: { count: 3 } });
    expect(row.headers).toEqual({ count: 3 });
  });

  it("returns class instances by reference and keeps other values intact", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const buffer = Buffer.from("x");
    const row = redactLogData({
      created_at: createdAt,
      buffer,
      url: "https://example.com",
      credits_cost: 1,
      options: null,
    });

    expect(row.created_at).toBe(createdAt);
    expect(row.buffer).toBe(buffer);
    expect(row.url).toBe("https://example.com");
    expect(row.credits_cost).toBe(1);
    expect(row.options).toBeNull();
  });
});
