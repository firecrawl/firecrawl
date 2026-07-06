import { eq } from "drizzle-orm";
import { idmux, map, scrape, scrapeRaw, scrapeTimeout } from "./lib";
import { createTestIdUrl, describeIf, Identity, TEST_PRODUCTION } from "../lib";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { parseApi } from "../../../lib/parseApi";

// Needs idmux (to create teams with the keyRestriction flag) and direct DB
// access (to seed key_restriction_config), so production-suite only.
describeIf(TEST_PRODUCTION)(
  "Key restriction (keyRestriction team flag)",
  () => {
    const seededKeyIds: number[] = [];

    async function seedRestriction(
      identity: Identity,
      restriction: { allowedFormats?: string[]; allowedEndpoints?: string[] },
    ) {
      const [keyRow] = await db
        .select({ id: schema.api_keys.id })
        .from(schema.api_keys)
        .where(eq(schema.api_keys.key, parseApi(identity.apiKey)))
        .limit(1);
      expect(keyRow).toBeDefined();

      await db.insert(schema.key_restriction_config).values({
        api_key_id: keyRow!.id,
        team_id: identity.teamId,
        allowed_formats: restriction.allowedFormats ?? [],
        allowed_endpoints: restriction.allowedEndpoints ?? [],
      });
      seededKeyIds.push(keyRow!.id);
    }

    afterAll(async () => {
      for (const keyId of seededKeyIds) {
        await db
          .delete(schema.key_restriction_config)
          .where(eq(schema.key_restriction_config.api_key_id, keyId));
      }
    });

    it.concurrent(
      "allows markdown scrapes on a markdown-only key",
      async () => {
        const identity = await idmux({
          name: "key-restriction/markdown-allowed",
          credits: 10000,
          flags: { keyRestriction: true },
        });
        await seedRestriction(identity, { allowedFormats: ["markdown"] });

        // Explicit markdown and the implicit default must both pass.
        const doc = await scrape(
          { url: createTestIdUrl(), formats: ["markdown"] },
          identity,
        );
        expect(doc.markdown).toBeDefined();

        const docDefault = await scrape({ url: createTestIdUrl() }, identity);
        expect(docDefault.markdown).toBeDefined();
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "rejects non-allowed formats on a markdown-only key",
      async () => {
        const identity = await idmux({
          name: "key-restriction/format-blocked",
          credits: 10000,
          flags: { keyRestriction: true },
        });
        await seedRestriction(identity, { allowedFormats: ["markdown"] });

        const response = await scrapeRaw(
          { url: createTestIdUrl(), formats: ["markdown", "rawHtml"] },
          identity,
        );

        expect(response.statusCode).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain(
          "restricted to the following formats",
        );
      },
      scrapeTimeout,
    );

    it.concurrent(
      "rejects content-returning actions on a format-restricted key",
      async () => {
        const identity = await idmux({
          name: "key-restriction/action-blocked",
          credits: 10000,
          flags: { keyRestriction: true },
        });
        await seedRestriction(identity, { allowedFormats: ["markdown"] });

        const response = await scrapeRaw(
          {
            url: createTestIdUrl(),
            formats: ["markdown"],
            actions: [{ type: "screenshot" }],
          },
          identity,
        );

        expect(response.statusCode).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain("screenshot");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "enforces the endpoint allowlist",
      async () => {
        const identity = await idmux({
          name: "key-restriction/endpoint",
          credits: 10000,
          flags: { keyRestriction: true },
        });
        await seedRestriction(identity, { allowedEndpoints: ["scrape"] });

        // Allowed endpoint group works...
        await scrape({ url: createTestIdUrl() }, identity);

        // ...anything else is rejected at auth.
        const response = await map({ url: "https://firecrawl.dev" }, identity);
        expect(response.statusCode).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain(
          "restricted to the following endpoints",
        );
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "does not restrict a flagged team before it configures a restriction",
      async () => {
        const identity = await idmux({
          name: "key-restriction/no-config",
          credits: 10000,
          flags: { keyRestriction: true },
        });

        const doc = await scrape(
          { url: createTestIdUrl(), formats: ["rawHtml"] },
          identity,
        );
        expect(doc.rawHtml).toBeDefined();
      },
      scrapeTimeout,
    );

    it.concurrent(
      "does not restrict when the flag is off even if a config exists",
      async () => {
        const identity = await idmux({
          name: "key-restriction/no-flag",
          credits: 10000,
        });
        await seedRestriction(identity, { allowedFormats: ["markdown"] });

        const doc = await scrape(
          { url: createTestIdUrl(), formats: ["rawHtml"] },
          identity,
        );
        expect(doc.rawHtml).toBeDefined();
      },
      scrapeTimeout,
    );
  },
);
