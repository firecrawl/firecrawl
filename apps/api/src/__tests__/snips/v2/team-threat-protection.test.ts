import request from "supertest";
import {
  describeIf,
  idmux,
  Identity,
  TEST_API_URL,
  TEST_PRODUCTION,
} from "../lib";
import { THREAT_PROTECTION_POLICY_DEFAULTS } from "../../../lib/threat-protection/types";

async function getConfigRaw(identity: Identity) {
  return await request(TEST_API_URL)
    .get("/v2/team/threat-protection")
    .set("Authorization", `Bearer ${identity.apiKey}`);
}

async function putConfigRaw(body: unknown, identity: Identity) {
  return await request(TEST_API_URL)
    .put("/v2/team/threat-protection")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body as object);
}

// Requires DB authentication + idmux-provisioned team flags, which only exist
// in the production test configuration.
describeIf(TEST_PRODUCTION)("Team threat protection config API", () => {
  describe("without the team flag", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "team-threat-protection/no-flag",
      });
    });

    it("GET returns 403", async () => {
      const res = await getConfigRaw(identity);
      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("enterprise feature");
    });

    it("PUT returns 403", async () => {
      const res = await putConfigRaw({ mode: "normal" }, identity);
      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("enterprise feature");
    });
  });

  describe("with the team flag", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "team-threat-protection/flagged",
        flags: {
          threatProtection: "allowed",
        },
      });
    });

    it("GET returns the default (unconfigured) effective config", async () => {
      const res = await getConfigRaw(identity);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        mode: "off",
        ...THREAT_PROTECTION_POLICY_DEFAULTS,
        allowRequestOverrides: true,
        siem: null,
        configured: false,
      });
    });

    it("PUT round-trips a full config document", async () => {
      const doc = {
        mode: "enhanced",
        riskScoreThreshold: 60,
        deniedCategories: ["Malicious", "Phishing"],
        maxDomainAgeDays: 30,
        blacklist: ["*.bad.example"],
        whitelist: ["firecrawl.dev"],
        blockedTlds: ["zip"],
        blockedCountries: ["KP"],
        failurePolicy: "open",
        allowRequestOverrides: false,
        siem: {
          url: "https://siem.example.com/ingest",
          secret: "test-secret",
          events: "all",
        },
      };

      const put = await putConfigRaw(doc, identity);
      expect(put.statusCode).toBe(200);
      expect(put.body.success).toBe(true);
      expect(put.body.data).toMatchObject({
        mode: "enhanced",
        riskScoreThreshold: 60,
        deniedCategories: ["Malicious", "Phishing"],
        maxDomainAgeDays: 30,
        blacklist: ["*.bad.example"],
        whitelist: ["firecrawl.dev"],
        blockedTlds: ["zip"],
        blockedCountries: ["KP"],
        failurePolicy: "open",
        allowRequestOverrides: false,
        configured: true,
      });
      // The SIEM secret must never be echoed back.
      expect(put.body.data.siem).toEqual({
        url: "https://siem.example.com/ingest",
        events: "all",
        secretSet: true,
      });

      const get = await getConfigRaw(identity);
      expect(get.statusCode).toBe(200);
      expect(get.body.data).toMatchObject({
        mode: "enhanced",
        riskScoreThreshold: 60,
        configured: true,
      });
      expect(get.body.data.siem?.secretSet).toBe(true);
      expect(JSON.stringify(get.body.data)).not.toContain("test-secret");
    });

    it("PUT without a secret preserves the stored SIEM secret (write-only contract)", async () => {
      const withSecret = await putConfigRaw(
        {
          mode: "normal",
          siem: {
            url: "https://siem.example.com/ingest",
            secret: "keep-me",
            events: "blocked",
          },
        },
        identity,
      );
      expect(withSecret.statusCode).toBe(200);
      expect(withSecret.body.data.siem.secretSet).toBe(true);

      // Update the destination without resending the secret — it must survive.
      const withoutSecret = await putConfigRaw(
        {
          mode: "normal",
          siem: {
            url: "https://siem2.example.com/ingest",
            events: "all",
          },
        },
        identity,
      );
      expect(withoutSecret.statusCode).toBe(200);
      expect(withoutSecret.body.data.siem).toEqual({
        url: "https://siem2.example.com/ingest",
        events: "all",
        secretSet: true,
      });

      // Disabling SIEM entirely is the way to clear the secret.
      const disabled = await putConfigRaw(
        { mode: "normal", siem: null },
        identity,
      );
      expect(disabled.statusCode).toBe(200);
      expect(disabled.body.data.siem).toBeNull();

      const reEnabled = await putConfigRaw(
        {
          mode: "normal",
          siem: {
            url: "https://siem2.example.com/ingest",
            events: "all",
          },
        },
        identity,
      );
      expect(reEnabled.statusCode).toBe(200);
      expect(reEnabled.body.data.siem.secretSet).toBe(false);
    });

    it("PUT is a full-document update (unspecified fields reset to defaults)", async () => {
      const put = await putConfigRaw({ mode: "normal" }, identity);
      expect(put.statusCode).toBe(200);
      expect(put.body.data).toMatchObject({
        mode: "normal",
        ...THREAT_PROTECTION_POLICY_DEFAULTS,
        allowRequestOverrides: true,
        siem: null,
        configured: true,
      });
    });

    it("PUT rejects an invalid document with 400", async () => {
      const res = await putConfigRaw(
        {
          mode: "enhanced",
          riskScoreThreshold: 500,
          blacklist: ["https://not-a-domain"],
        },
        identity,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
