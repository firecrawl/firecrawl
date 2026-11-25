import { describe, test, expect, vi, afterEach } from "vitest";
import axios from "axios";
import { FirecrawlAppV1 } from "../../../index";
import { version } from "../../../../package.json";

describe("v1 origin version", () => {
  const originalPackageVersion = process.env.npm_package_version;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPackageVersion === undefined)
      delete process.env.npm_package_version;
    else process.env.npm_package_version = originalPackageVersion;
  });

  test("first and later requests send the bundled SDK version, not the host package version", async () => {
    process.env.npm_package_version = "0.2.0";
    const origins: unknown[] = [];
    vi.spyOn(axios, "post").mockImplementation(
      async (_url: string, data?: any) => {
        origins.push(data?.origin);
        return {
          status: 200,
          data: { success: true, data: { markdown: "ok" } },
        };
      },
    );

    const app = new FirecrawlAppV1({
      apiKey: "fc-test",
      apiUrl: "https://api.firecrawl.dev",
    });
    await app.scrapeUrl("https://example.com");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.scrapeUrl("https://example.com");

    expect(origins).toEqual([`js-sdk@${version}`, `js-sdk@${version}`]);
  });
});
