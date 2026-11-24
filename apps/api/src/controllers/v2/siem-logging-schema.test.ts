import { describe, expect, it } from "vitest";
import { siemLoggingConfigInputSchema } from "../../lib/siem-logging/types";

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
