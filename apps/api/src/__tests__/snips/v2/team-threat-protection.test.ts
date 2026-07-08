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
        configured: false,
      });
      expect(res.body.data).not.toHaveProperty("siem");
    });

    it("PUT round-trips a full config document", async () => {
      const doc = {
        mode: "normal",
        riskScoreThreshold: 60,
        blacklist: ["*.bad.example"],
        whitelist: ["firecrawl.dev"],
        blockedTlds: ["zip"],
        failurePolicy: "open",
        allowRequestOverrides: false,
      };

      const put = await putConfigRaw(doc, identity);
      expect(put.statusCode).toBe(200);
      expect(put.body.success).toBe(true);
      expect(put.body.data).toMatchObject({
        mode: "normal",
        riskScoreThreshold: 60,
        blacklist: ["*.bad.example"],
        whitelist: ["firecrawl.dev"],
        blockedTlds: ["zip"],
        failurePolicy: "open",
        allowRequestOverrides: false,
        configured: true,
      });
      // Retired policy fields must not appear in the served document.
      expect(put.body.data).not.toHaveProperty("siem");
      expect(put.body.data).not.toHaveProperty("deniedCategories");
      expect(put.body.data).not.toHaveProperty("maxDomainAgeDays");
      expect(put.body.data).not.toHaveProperty("blockedCountries");

      const get = await getConfigRaw(identity);
      expect(get.statusCode).toBe(200);
      expect(get.body.data).toMatchObject({
        mode: "normal",
        riskScoreThreshold: 60,
        configured: true,
      });
      expect(get.body.data).not.toHaveProperty("siem");
      expect(get.body.data).not.toHaveProperty("deniedCategories");
      expect(get.body.data).not.toHaveProperty("maxDomainAgeDays");
      expect(get.body.data).not.toHaveProperty("blockedCountries");
    });

    it("PUT is a full-document update (unspecified fields reset to defaults)", async () => {
      const put = await putConfigRaw({ mode: "normal" }, identity);
      expect(put.statusCode).toBe(200);
      expect(put.body.data).toMatchObject({
        mode: "normal",
        ...THREAT_PROTECTION_POLICY_DEFAULTS,
        allowRequestOverrides: true,
        configured: true,
      });
      expect(put.body.data).not.toHaveProperty("siem");
    });

    it("PUT rejects an invalid document with 400", async () => {
      const res = await putConfigRaw(
        {
          mode: "normal",
          riskScoreThreshold: 500,
          blacklist: ["https://not-a-domain"],
        },
        identity,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('PUT rejects the retired "enhanced" mode with 400', async () => {
      const res = await putConfigRaw({ mode: "enhanced" }, identity);
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("PUT rejects retired policy fields with 400", async () => {
      for (const retired of [
        { siem: { url: "https://siem.example.com/ingest" } },
        { deniedCategories: ["Malicious"] },
        { maxDomainAgeDays: 30 },
        { blockedCountries: ["KP"] },
      ]) {
        const res = await putConfigRaw(
          { mode: "normal", ...retired },
          identity,
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
      }
    });
  });

  describe("with the forced team flag", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "team-threat-protection/forced",
        flags: {
          threatProtection: "forced",
        },
      });
    });

    it('PUT rejects mode "off" with 403', async () => {
      const res = await putConfigRaw({ mode: "off" }, identity);
      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("enforced");
      expect(res.body.error).toContain('"off"');
    });

    it('PUT accepts mode "normal" with 200 (forced teams may tighten config)', async () => {
      const res = await putConfigRaw({ mode: "normal" }, identity);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        mode: "normal",
        configured: true,
      });
    });
  });
});
