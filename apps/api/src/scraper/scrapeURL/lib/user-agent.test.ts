import { describe, expect, it } from "vitest";
import {
  FIRE_CRAWL_AGENT_USER_AGENT,
  buildHeadersWithUserAgent,
} from "./user-agent";

describe("buildHeadersWithUserAgent", () => {
  it("stamps the default User-Agent when the caller sends none", () => {
    expect(buildHeadersWithUserAgent()).toEqual({
      "User-Agent": FIRE_CRAWL_AGENT_USER_AGENT,
    });
  });

  it("keeps caller headers and adds the default User-Agent", () => {
    expect(
      buildHeadersWithUserAgent({ "Content-Type": "application/json" }),
    ).toEqual({
      "User-Agent": FIRE_CRAWL_AGENT_USER_AGENT,
      "Content-Type": "application/json",
    });
  });

  it("does not duplicate a caller-supplied User-Agent", () => {
    const headers = buildHeadersWithUserAgent({
      "User-Agent": "MyBot/2.0",
      Accept: "text/html",
    });

    expect(headers).toEqual({
      "User-Agent": "MyBot/2.0",
      Accept: "text/html",
    });
  });

  it("matches the User-Agent key case-insensitively", () => {
    // Header names are case-insensitive on the wire; sending both would let
    // undici pick one arbitrarily.
    expect(
      buildHeadersWithUserAgent({
        "user-agent": "MyBot/2.0",
        "USER-AGENT": "Other/1.0",
      }),
    ).toEqual({ "User-Agent": "MyBot/2.0" });
  });

  it("lets the caller override the default user agent value", () => {
    expect(buildHeadersWithUserAgent(undefined, "TestAgent/9.9")).toEqual({
      "User-Agent": "TestAgent/9.9",
    });
  });

  it("pins the identifiable scraper User-Agent", () => {
    // Site operators block Firecrawl by matching this string; changing it is
    // a breaking change for their nginx/Cloudflare rules.
    expect(FIRE_CRAWL_AGENT_USER_AGENT).toBe("FireCrawlAgent/1.0.0");
  });
});
