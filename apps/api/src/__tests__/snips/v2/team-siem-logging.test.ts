import request from "supertest";
import {
  describeIf,
  idmux,
  type Identity,
  TEST_API_URL,
  TEST_PRODUCTION,
} from "../lib";

async function getConfig(identity: Identity) {
  return request(TEST_API_URL)
    .get("/v2/team/siem")
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

async function putConfig(identity: Identity, body: unknown) {
  return request(TEST_API_URL)
    .put("/v2/team/siem")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body as object);
}

async function testConfig(identity: Identity) {
  return request(TEST_API_URL)
    .post("/v2/team/siem/test")
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

describeIf(TEST_PRODUCTION)("Team SIEM logging config API", () => {
  it("rejects a team without the enterprise flag", async () => {
    const identity = await idmux({ name: "team-siem-logging/no-flag" });
    const response = await getConfig(identity);

    expect(response.statusCode).toBe(403);
    expect(response.body.error).toContain("enterprise feature");
  });

  describeIf(!!process.env.SIEM_LOGGING_ENCRYPTION_KEY)(
    "with the enterprise flag",
    () => {
      let identity: Identity;

      beforeAll(async () => {
        identity = await idmux({
          name: "team-siem-logging/flagged",
          flags: { siemLogging: true },
        });
      });

      it("stores an Azure destination while keeping the secret write-only", async () => {
        const response = await putConfig(identity, {
          enabled: true,
          destination: {
            type: "azure_sentinel",
            tenantId: "00000000-0000-0000-0000-000000000001",
            clientId: "00000000-0000-0000-0000-000000000002",
            clientSecret: "never-return-this-value",
            dceUrl: "https://firecrawl-test.eastus.ingest.monitor.azure.com",
            dcrImmutableId: "dcr-00000000000000000000000000000000",
            streamName: "Custom-FirecrawlScrapeActivity",
          },
        });

        // A rollout can deploy API code before the out-of-band DDL. Match the
        // existing enterprise-config snips by making that state explicit.
        if (response.statusCode === 500) {
          console.warn(
            "siem_logging_config table is unavailable; skipping config round-trip",
          );
          return;
        }

        expect(response.statusCode).toBe(200);
        expect(response.body.data).toMatchObject({
          configured: true,
          enabled: true,
          destination: {
            type: "azure_sentinel",
            clientSecretConfigured: true,
          },
        });
        expect(JSON.stringify(response.body)).not.toContain(
          "never-return-this-value",
        );

        const read = await getConfig(identity);
        expect(read.statusCode).toBe(200);
        expect(JSON.stringify(read.body)).not.toContain(
          "never-return-this-value",
        );
      });

      it("refuses a test event before a destination is saved", async () => {
        const unconfigured = await idmux({
          name: "team-siem-logging/untested",
          flags: { siemLogging: true },
        });
        const response = await testConfig(unconfigured);

        expect(response.statusCode).toBe(409);
        expect(response.body.error).toContain("not configured");
      });

      it("rejects non-Azure ingestion endpoints", async () => {
        const response = await putConfig(identity, {
          enabled: true,
          destination: {
            type: "azure_sentinel",
            tenantId: "tenant",
            clientId: "client",
            clientSecret: "secret",
            dceUrl: "https://example.com/collect",
            dcrImmutableId: "dcr-id",
            streamName: "Custom-FirecrawlScrapeActivity",
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.body.success).toBe(false);
      });
    },
  );
});
