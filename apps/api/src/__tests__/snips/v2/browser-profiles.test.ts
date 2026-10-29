import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../../config";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";
import { idmux, Identity } from "./lib";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";

describeIf(TEST_PRODUCTION && !!config.HANGAR_URL)(
  "DELETE /v2/browser/profiles/:name",
  () => {
    let identity: Identity;
    const profileNames: string[] = [];

    beforeAll(async () => {
      identity = await idmux({ name: "browser-profiles-delete", credits: 100 });
    });

    afterAll(async () => {
      if (profileNames.length > 0) {
        await db
          .delete(schema.browser_profiles)
          .where(
            and(
              eq(schema.browser_profiles.team_id, identity.teamId),
              inArray(schema.browser_profiles.name, profileNames),
            ),
          );
      }
    });

    const del = (name: string, apiKey: string | null = identity.apiKey) => {
      const req = request(TEST_API_URL).delete(
        `/v2/browser/profiles/${encodeURIComponent(name)}`,
      );
      if (apiKey !== null) req.set("Authorization", `Bearer ${apiKey}`);
      return req.send();
    };

    const profileExists = async (name: string) =>
      (
        await db
          .select()
          .from(schema.browser_profiles)
          .where(
            and(
              eq(schema.browser_profiles.team_id, identity.teamId),
              eq(schema.browser_profiles.name, name),
            ),
          )
      ).length > 0;

    it("deletes a listed profile", async () => {
      // Includes a slash and a space, which must survive URL encoding.
      const name = `snips-${uuidv7()}/a b`;
      profileNames.push(name);
      await db.insert(schema.browser_profiles).values({
        team_id: identity.teamId,
        name,
        saved_at: "2026-09-22T10:00:00.000Z",
        size_bytes: 100,
      });

      const res = await del(name);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(await profileExists(name)).toBe(false);
    });

    it("succeeds for a profile with no saved state", async () => {
      const res = await del(`snips-missing-${uuidv7()}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it("rejects names over 128 characters and unauthenticated requests", async () => {
      expect((await del("x".repeat(129))).statusCode).toBe(400);
      expect((await del(`snips-${uuidv7()}`, null)).statusCode).toBe(401);
    });
  },
);
