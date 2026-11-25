import { afterEach, beforeEach, describe, test, expect } from "vitest";
import type { AxiosAdapter } from "axios";
import { FirecrawlClient } from "../../../v2/client";
import { Firecrawl } from "../../../index";
import { getVersion } from "../../../v2/utils/getVersion";
import { detectCallerPackage } from "../../../utils/callerOrigin";

function withCapture<T extends { http: any }>(client: T) {
  const bodies: Array<Record<string, unknown>> = [];
  const adapter: AxiosAdapter = async config => {
    bodies.push(JSON.parse(config.data));
    return {
      data: { success: true, data: { markdown: "# hello" } },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  client.http.instance.defaults.adapter = adapter;
  return { client, bodies };
}

describe("v2 request origin", () => {
  const previousOptOut = process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN;
  afterEach(() => {
    if (previousOptOut === undefined) {
      delete process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN;
    } else {
      process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN = previousOptOut;
    }
  });

  test("defaults to the plain SDK origin when application code creates the client", async () => {
    const { client, bodies } = withCapture(new FirecrawlClient({ apiKey: "fc-test" }));
    await client.scrape("https://example.com");
    expect(bodies[0]!.origin).toBe(`js-sdk@${getVersion()}`);
  });

  test("the origin client option is stamped into request bodies", async () => {
    const { client, bodies } = withCapture(
      new FirecrawlClient({ apiKey: "fc-test", origin: "js-sdk.example@1.0.0" }),
    );
    await client.scrape("https://example.com");
    expect(bodies[0]!.origin).toBe("js-sdk.example@1.0.0");
  });

  test("a per-call origin wins over the client origin", async () => {
    const { client, bodies } = withCapture(
      new FirecrawlClient({ apiKey: "fc-test", origin: "js-sdk.example@1.0.0" }),
    );
    await client.scrape("https://example.com", { origin: "per-call" } as any);
    await client.scrape("https://example.com", { origin: "mcp-server" } as any);
    expect(bodies.map(b => b.origin)).toEqual(["per-call", "mcp-server"]);
  });

  test("the unified client forwards the origin option to v1", () => {
    const app = new Firecrawl({ apiKey: "fc-test", origin: "js-sdk.example@1.0.0" });
    expect((app.v1 as any).clientOrigin).toBe("js-sdk.example@1.0.0");
  });

});

describe("detectCallerPackage", () => {
  const sdkFrames = [
    "Error",
    "    at detectCallerPackage (file:///srv/app/node_modules/@mendable/firecrawl-js/dist/index.js:10:5)",
    "    at new FirecrawlClient (file:///srv/app/node_modules/@mendable/firecrawl-js/dist/index.js:20:9)",
  ];
  const stackFrom = (...callers: string[]) =>
    [...sdkFrames, ...callers.map(c => `    at ${c}`)].join("\n");
  const previousOptOut = process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN;

  beforeEach(() => {
    delete process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN;
  });

  afterEach(() => {
    if (previousOptOut === undefined) {
      delete process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN;
    } else {
      process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN = previousOptOut;
    }
  });

  test("names the scoped package that created the client", () => {
    const stack = stackFrom(
      "make (file:///srv/app/node_modules/@Scope/Some_Agent/dist/index.js:3:12)",
      "main (file:///srv/app/src/main.js:1:1)",
    );
    expect(detectCallerPackage(stack)).toBe("scope-some-agent");
  });

  test("uses the last node_modules segment of a nested install", () => {
    const stack = stackFrom(
      "make (/srv/app/node_modules/.pnpm/outer@1.0.0/node_modules/inner-pkg/lib/index.cjs:3:12)",
    );
    expect(detectCallerPackage(stack)).toBe("inner-pkg");
  });

  test("handles windows paths with parentheses and anonymous frames", () => {
    const stack = stackFrom(
      "Array.map (<anonymous>)",
      "C:\\Program Files (x86)\\app\\node_modules\\wrapper\\index.js:4:2",
    );
    expect(detectCallerPackage(stack)).toBe("wrapper");
  });

  test("returns null when application code created the client", () => {
    const stack = stackFrom(
      "main (file:///srv/app/src/main.js:1:1)",
      "make (file:///srv/app/node_modules/wrapper/index.js:3:12)",
    );
    expect(detectCallerPackage(stack)).toBeNull();
  });

  test("returns null for a package whose slug would read as another traffic class", () => {
    const stack = stackFrom("make (/srv/app/node_modules/my-playground-kit/index.js:3:12)");
    expect(detectCallerPackage(stack)).toBeNull();
  });

  test("returns null for a bundle without node_modules in its path", () => {
    expect(detectCallerPackage(stackFrom("make (/srv/app/dist/bundle.js:1:1)"))).toBeNull();
  });

  test("FIRECRAWL_DISABLE_CALLER_ORIGIN turns detection off", () => {
    const stack = stackFrom("make (/srv/app/node_modules/wrapper/index.js:3:12)");
    expect(detectCallerPackage(stack)).toBe("wrapper");
    process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN = "1";
    expect(detectCallerPackage(stack)).toBeNull();
  });
});
