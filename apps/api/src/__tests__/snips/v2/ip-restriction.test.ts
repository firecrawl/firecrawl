import { eq } from "drizzle-orm";
import { idmux, scrape, scrapeRaw, scrapeTimeout } from "./lib";
import { createTestIdUrl, describeIf, TEST_PRODUCTION } from "../lib";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";

// Needs idmux (to create teams with the ipRestriction flag) and direct DB
// access (to seed ip_restriction_config), so production-suite only.
describeIf(TEST_PRODUCTION)("IP restriction (ipRestriction team flag)", () => {
  const seededTeamIds: string[] = [];

  async function seedAllowlist(teamId: string, allowedIps: string[]) {
    await db.insert(schema.ip_restriction_config).values({
      team_id: teamId,
      allowed_ips: allowedIps,
    });
    seededTeamIds.push(teamId);
  }

  afterAll(async () => {
    for (const teamId of seededTeamIds) {
      await db
        .delete(schema.ip_restriction_config)
        .where(eq(schema.ip_restriction_config.team_id, teamId));
    }
  });

  it.concurrent(
    "allows requests when the client IP is on the allowlist",
    async () => {
      const identity = await idmux({
        name: "ip-restriction/allowed",
        credits: 10000,
        flags: { ipRestriction: true },
      });
      await seedAllowlist(identity.teamId, ["0.0.0.0/0", "::/0"]);

      await scrape({ url: createTestIdUrl() }, identity);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects requests from an IP that is not on the allowlist",
    async () => {
      const identity = await idmux({
        name: "ip-restriction/blocked",
        credits: 10000,
        flags: { ipRestriction: true },
      });
      // TEST-NET-3 address; the test runner's IP can never match it.
      await seedAllowlist(identity.teamId, ["203.0.113.7"]);

      const response = await scrapeRaw({ url: createTestIdUrl() }, identity);

      expect(response.statusCode).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("allowed IP list");
    },
    scrapeTimeout,
  );

  it.concurrent(
    "does not restrict a flagged team before it configures an allowlist",
    async () => {
      const identity = await idmux({
        name: "ip-restriction/no-config",
        credits: 10000,
        flags: { ipRestriction: true },
      });

      await scrape({ url: createTestIdUrl() }, identity);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "does not restrict when the flag is off even if an allowlist exists",
    async () => {
      const identity = await idmux({
        name: "ip-restriction/no-flag",
        credits: 10000,
      });
      await seedAllowlist(identity.teamId, ["203.0.113.7"]);

      await scrape({ url: createTestIdUrl() }, identity);
    },
    scrapeTimeout,
  );
});
