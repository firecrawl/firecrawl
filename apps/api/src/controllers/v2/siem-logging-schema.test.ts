import { describe, expect, it } from "vitest";
import {
  agentRequestSchema,
  batchScrapeRequestSchema,
  crawlRequestSchema,
  extractRequestSchema,
  mapRequestSchema,
  scrapeRequestSchema,
  searchRequestSchema,
} from "./types";
import {
  batchScrapeRequestSchema as batchScrapeRequestSchemaV1,
  crawlRequestSchema as crawlRequestSchemaV1,
  extractRequestSchema as extractRequestSchemaV1,
  mapRequestSchema as mapRequestSchemaV1,
  scrapeRequestSchema as scrapeRequestSchemaV1,
  searchRequestSchema as searchRequestSchemaV1,
} from "../v1/types";
import { siemLoggingConfigInputSchema } from "../../lib/siem-logging/types";

const auditMetadata = {
  username: "alice@example.com",
};

describe("auditMetadata request validation", () => {
  it("accepts audit metadata across every scrape-producing request schema", () => {
    expect(
      scrapeRequestSchema.parse({
        url: "https://example.com",
        auditMetadata,
      }).auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      batchScrapeRequestSchema.parse({
        urls: ["https://example.com"],
        auditMetadata,
      }).auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      crawlRequestSchema.parse({
        url: "https://example.com",
        scrapeOptions: { auditMetadata },
      }).scrapeOptions.auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      searchRequestSchema.parse({
        query: "example",
        scrapeOptions: { auditMetadata },
      }).scrapeOptions?.auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      extractRequestSchema.parse({
        urls: ["https://example.com"],
        scrapeOptions: { auditMetadata },
      }).scrapeOptions?.auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      mapRequestSchema.parse({
        url: "https://example.com",
        auditMetadata,
      }).auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      agentRequestSchema.parse({
        prompt: "Find the pricing page",
        auditMetadata,
      }).auditMetadata,
    ).toEqual(auditMetadata);
  });

  it("rejects unsupported audit metadata fields", () => {
    expect(() =>
      scrapeRequestSchema.parse({
        url: "https://example.com",
        auditMetadata: {
          username: "alice@example.com",
          session: "session-123",
        },
      }),
    ).toThrow();
  });

  it("requires username when audit metadata is provided", () => {
    expect(() =>
      scrapeRequestSchema.parse({
        url: "https://example.com",
        auditMetadata: {},
      }),
    ).toThrow();
  });

  it("accepts audit metadata on the corresponding v1 request schemas", () => {
    expect(
      scrapeRequestSchemaV1.parse({
        url: "https://example.com",
        auditMetadata,
      }).auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      batchScrapeRequestSchemaV1.parse({
        urls: ["https://example.com"],
        auditMetadata,
      }).auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      crawlRequestSchemaV1.parse({
        url: "https://example.com",
        scrapeOptions: { auditMetadata },
      }).scrapeOptions.auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      searchRequestSchemaV1.parse({
        query: "example",
        scrapeOptions: { auditMetadata },
      }).scrapeOptions.auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      extractRequestSchemaV1.parse({
        urls: ["https://example.com"],
        scrapeOptions: { auditMetadata },
      }).scrapeOptions?.auditMetadata,
    ).toEqual(auditMetadata);
    expect(
      mapRequestSchemaV1.parse({
        url: "https://example.com",
        auditMetadata,
      }).auditMetadata,
    ).toEqual(auditMetadata);
  });
});

describe("SIEM destination validation", () => {
  const destination = {
    type: "azure_sentinel" as const,
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
    dceUrl: "https://example.eastus.ingest.monitor.azure.com",
    dcrImmutableId: "dcr-id",
    streamName: "Custom-FirecrawlScrapeActivity",
  };

  it("trims credential and destination fields", () => {
    const parsed = siemLoggingConfigInputSchema.parse({
      enabled: true,
      destination: {
        ...destination,
        tenantId: " tenant ",
        clientId: " client ",
        clientSecret: " secret ",
      },
    });

    expect(parsed.destination).toMatchObject({
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
    });
  });

  it("rejects whitespace-only credentials and endpoint userinfo", () => {
    expect(() =>
      siemLoggingConfigInputSchema.parse({
        enabled: true,
        destination: { ...destination, clientSecret: "   " },
      }),
    ).toThrow();
    expect(() =>
      siemLoggingConfigInputSchema.parse({
        enabled: true,
        destination: {
          ...destination,
          dceUrl:
            "https://user:password@example.eastus.ingest.monitor.azure.com",
        },
      }),
    ).toThrow("credential-free");
  });
});
