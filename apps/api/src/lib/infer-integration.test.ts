import { describe, expect, it } from "vitest";
import { inferIntegration } from "./infer-integration";

describe("inferIntegration from a browser page", () => {
  it("slugs the Origin host", () => {
    expect(inferIntegration({ origin: "https://App.Example.com:8443" })).toBe(
      "_ref.app-example-com",
    );
  });

  it("drops a leading www.", () => {
    expect(inferIntegration({ origin: "https://www.example.com" })).toBe(
      "_ref.example-com",
    );
  });

  it("falls back to the Referer host without path or query", () => {
    expect(
      inferIntegration({ referer: "https://example.org/a/b?token=1#x" }),
    ).toBe("_ref.example-org");
  });

  it("prefers Origin over Referer", () => {
    expect(
      inferIntegration({
        origin: "https://one.example.com",
        referer: "https://two.example.com/page",
      }),
    ).toBe("_ref.one-example-com");
  });

  it("caps the slug at 48 characters", () => {
    const slug = inferIntegration({
      origin: `https://${"a".repeat(30)}.${"b".repeat(30)}.com`,
    })!.slice("_ref.".length);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it.each([
    "null",
    "http://localhost:3000",
    "http://app.localhost",
    "http://printer.local",
    "http://local",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "https://firecrawl.dev",
    "https://www.firecrawl.dev",
    "https://docs.firecrawl.dev",
    "chrome-extension://abcdefghijklmnop",
  ])("skips %s", origin => {
    expect(inferIntegration({ origin })).toBeUndefined();
  });

  it("does not fall through to the User-Agent when the page host is skipped", () => {
    expect(
      inferIntegration({
        origin: "https://www.firecrawl.dev",
        userAgent: "SomeTool/1.0",
      }),
    ).toBeUndefined();
  });

  it("keeps a lookalike host", () => {
    expect(inferIntegration({ origin: "https://notfirecrawl.dev" })).toBe(
      "_ref.notfirecrawl-dev",
    );
  });
});

describe("inferIntegration from the User-Agent", () => {
  it("slugs the first product token", () => {
    expect(inferIntegration({ userAgent: "PostmanRuntime/7.39.0" })).toBe(
      "_ua.postmanruntime",
    );
    expect(
      inferIntegration({ userAgent: "Some_Tool/2.1 (linux; x64) extra/1" }),
    ).toBe("_ua.some-tool");
  });

  it("accepts a product token with no version", () => {
    expect(inferIntegration({ userAgent: "insomnia" })).toBe("_ua.insomnia");
  });

  it.each([
    "curl/8.5.0",
    "python-requests/2.31.0",
    "Python-urllib/3.12",
    "Go-http-client/2.0",
    "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
    "Mozilla/5.0 (X11; Linux x86_64)",
    "okhttp/4.12.0",
    "Java/17.0.2",
    "axios/1.6.0",
    "undici",
  ])("skips the generic runtime %s", userAgent => {
    expect(inferIntegration({ userAgent })).toBeUndefined();
  });

  it.each(["firecrawl-go/1.0.0", "firecrawl-php/1.0", "firecrawl-cli/1.2"])(
    "skips Firecrawl product %s",
    userAgent => {
      expect(inferIntegration({ userAgent })).toBeUndefined();
    },
  );

  it("skips when the body already carries a non-default origin", () => {
    expect(
      inferIntegration({
        userAgent: "SomeTool/1.0",
        bodyOrigin: "js-sdk@4.0.0",
      }),
    ).toBeUndefined();
    expect(
      inferIntegration({ userAgent: "SomeTool/1.0", bodyOrigin: "api" }),
    ).toBe("_ua.sometool");
    expect(
      inferIntegration({ userAgent: "SomeTool/1.0", bodyOrigin: " API " }),
    ).toBe("_ua.sometool");
  });

  it("skips empty or unusable User-Agents", () => {
    expect(inferIntegration({})).toBeUndefined();
    expect(inferIntegration({ userAgent: "   " })).toBeUndefined();
    expect(inferIntegration({ userAgent: "(compatible; x)" })).toBeUndefined();
  });
});
