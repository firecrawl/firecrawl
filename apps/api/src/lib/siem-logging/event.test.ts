import { describe, expect, it } from "vitest";
import type { ScrapeJobSingleUrls } from "../../types";
import { scrapeOptions } from "../../controllers/v2/types";
import { UnsafeDomainBlockedError } from "../threat-protection/error";
import type { ThreatDecision } from "../threat-protection/types";
import { CrawlDenialError } from "../error";
import {
  buildRejectedScrapeActivityEvent,
  buildScrapeActivityEvent,
} from "./event";

const allowedDecision: ThreatDecision = {
  allowed: true,
  rule: "default-allow",
  url: "https://example.com/",
  domain: "example.com",
  providerConsulted: true,
  verdict: {
    provider: "google-web-risk",
    riskScore: 0,
    categories: [],
    fromCache: false,
    raw: { mustNotLeak: true },
  },
  mode: "normal",
};

function job(
  overrides: Partial<ScrapeJobSingleUrls> = {},
): ScrapeJobSingleUrls {
  return {
    mode: "single_urls",
    url: "https://example.com/private?q=1",
    team_id: "00000000-0000-0000-0000-000000000001",
    scrapeOptions: scrapeOptions.parse({
      auditMetadata: { username: "alice@example.com" },
    }),
    internalOptions: {
      teamId: "00000000-0000-0000-0000-000000000001",
      orgId: "00000000-0000-0000-0000-000000000002",
    },
    origin: "api",
    integration: "sdk",
    zeroDataRetention: true,
    apiKeyId: 42,
    requestId: "00000000-0000-0000-0000-000000000003",
    billing: { endpoint: "search" },
    ...overrides,
  };
}

describe("ScrapeActivityEvent", () => {
  it("builds an attributable success event without raw classifier data", () => {
    const event = buildScrapeActivityEvent(
      "00000000-0000-0000-0000-000000000004",
      job(),
      "00000000-0000-0000-0000-000000000002",
      "production",
      {
        success: true,
        document: {
          markdown: "not included",
          metadata: { statusCode: 200, proxyUsed: "basic" },
        },
        threatDecisions: [allowedDecision],
        startedAt: 1_000,
        completedAt: 2_500,
      },
    );

    expect(event).toMatchObject({
      endpoint: "search",
      api_key: { id: "42", name: "production" },
      audit_metadata: { username: "alice@example.com" },
      domain: "example.com",
      result: "success",
      zero_data_retention: true,
      threat: {
        decision: "allow",
        provider: "google-web-risk",
        categories: [],
      },
    });
    expect(JSON.stringify(event)).not.toContain("mustNotLeak");
    expect(JSON.stringify(event)).not.toContain("not included");
  });

  it("omits audit metadata when no username is provided", () => {
    const event = buildScrapeActivityEvent(
      "scrape-id",
      job({ scrapeOptions: scrapeOptions.parse({}) }),
      "org-id",
      null,
      {
        success: true,
        startedAt: 1_000,
        completedAt: 2_000,
      },
    );

    expect(event).not.toHaveProperty("audit_metadata");
  });

  it("normalizes a blocked threat decision and error", () => {
    const denied: ThreatDecision = {
      ...allowedDecision,
      allowed: false,
      rule: "risk-score",
      verdict: {
        ...allowedDecision.verdict!,
        riskScore: 100,
        categories: ["MALWARE"],
      },
    };
    const error = new UnsafeDomainBlockedError(
      "https://example.com/private",
      denied,
    );
    const event = buildScrapeActivityEvent("scrape-id", job(), "org-id", null, {
      success: false,
      error,
      threatDecisions: [denied],
      startedAt: 1_000,
      completedAt: 2_000,
    });

    expect(event.result).toBe("blocked");
    expect(event.error?.code).toBe("unsafe_domain_blocked");
    expect(event.threat).toEqual({
      decision: "deny",
      rule: "risk-score",
      provider: "google-web-risk",
      categories: ["MALWARE"],
    });
  });

  // A local-rule deny never calls a provider, so it must not inherit the
  // categories of a redirect hop that did — downstream that would score a
  // policy block as a provider-confirmed threat.
  it("scopes the threat block to the deciding decision", () => {
    const provider: ThreatDecision = {
      ...allowedDecision,
      url: "https://redirect.example.com/",
      verdict: {
        ...allowedDecision.verdict!,
        riskScore: 100,
        categories: ["MALWARE"],
      },
    };
    const localDeny: ThreatDecision = {
      ...allowedDecision,
      allowed: false,
      rule: "blacklist",
      providerConsulted: false,
      verdict: null,
    };
    const event = buildScrapeActivityEvent("scrape-id", job(), "org-id", null, {
      success: false,
      error: new UnsafeDomainBlockedError(localDeny.url, localDeny),
      threatDecisions: [provider, localDeny],
      startedAt: 1_000,
      completedAt: 2_000,
    });

    expect(event.threat).toEqual({
      decision: "deny",
      rule: "blacklist",
      provider: null,
      categories: [],
    });
  });

  it("serializes circular and bigint non-Error failures", () => {
    const thrown: { count: bigint; self?: unknown } = { count: 42n };
    thrown.self = thrown;
    const event = buildScrapeActivityEvent("scrape-id", job(), "org-id", null, {
      success: false,
      error: thrown,
      startedAt: 1_000,
      completedAt: 2_000,
    });

    expect(event.result).toBe("failure");
    expect(event.error?.message).toContain('"count":"42"');
    expect(event.error?.message).toContain("[Circular]");
  });

  it("builds blocked events for requests rejected before job creation", () => {
    const denied: ThreatDecision = {
      ...allowedDecision,
      allowed: false,
      rule: "risk-score",
      verdict: {
        ...allowedDecision.verdict!,
        categories: ["SOCIAL_ENGINEERING"],
      },
    };
    const error = new UnsafeDomainBlockedError(denied.url, denied);
    const event = buildRejectedScrapeActivityEvent(
      {
        scrapeId: "blocked-scrape-id",
        requestId: "parent-request-id",
        endpoint: "batch_scrape",
        teamId: "team-id",
        apiKeyId: 42,
        auditMetadata: { username: "alice@example.com" },
        startedAt: 1_000,
        completedAt: 1_500,
        url: denied.url,
        error,
        threatDecisions: [denied],
        origin: "api",
        integration: "sdk",
        zeroDataRetention: true,
      },
      "org-id",
      "production",
    );

    expect(event).toMatchObject({
      scrape_id: "blocked-scrape-id",
      request_id: "parent-request-id",
      endpoint: "batch_scrape",
      result: "blocked",
      http_status: null,
      api_key: { id: "42", name: "production" },
      threat: {
        decision: "deny",
        categories: ["SOCIAL_ENGINEERING"],
      },
    });
  });

  it("classifies non-threat policy denials as blocked", () => {
    const event = buildRejectedScrapeActivityEvent(
      {
        scrapeId: "blocked-scrape-id",
        requestId: "parent-request-id",
        endpoint: "extract",
        teamId: "team-id",
        url: "https://example.com",
        error: new CrawlDenialError("URL blocked by policy"),
        origin: "api",
        zeroDataRetention: false,
      },
      "org-id",
      null,
    );

    expect(event.result).toBe("blocked");
    expect(event.error?.code).toBe("CRAWL_DENIAL");
    expect(event.threat).toBeUndefined();
  });
});
