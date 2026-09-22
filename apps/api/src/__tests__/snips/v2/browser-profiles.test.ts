import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../../config";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";
import { idmux, Identity } from "./lib";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { browserProfileStorageId } from "../../../lib/browser-profiles";

const WEBHOOK_SECRET = config.BROWSER_SERVICE_WEBHOOK_SECRET;

// The browser service reports each successful profile save to the same webhook
// as session.ended. These tests stand in for it, against a session row shaped
// like the one the API writes when a session is created with a profile.
describeIf(TEST_PRODUCTION && !!WEBHOOK_SECRET)(
  "Browser profile registry (profile.saved webhook)",
  () => {
    let identity: Identity;
    const sessionIds: string[] = [];
    const profileNames: string[] = [];

    beforeAll(async () => {
      identity = await idmux({ name: "browser-profiles", credits: 100 });
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
      if (sessionIds.length > 0) {
        await db
          .delete(schema.browser_sessions)
          .where(inArray(schema.browser_sessions.id, sessionIds));
      }
    });

    const newProfileName = () => {
      const name = `snips-${uuidv7()}`;
      profileNames.push(name);
      return name;
    };

    // Returns the browser-service session id the webhook addresses.
    const createSession = async (profileName: string | null) => {
      const id = uuidv7();
      const browserId = `snips-${id}`;
      await db.insert(schema.browser_sessions).values({
        id,
        team_id: identity.teamId,
        browser_id: browserId,
        workspace_id: "",
        context_id: "",
        cdp_url: "wss://example.invalid/cdp",
        cdp_path: "https://example.invalid/view",
        stream_web_view: false,
        status: "destroyed",
        ttl_total: 60,
        should_bill: false,
        profile_name: profileName,
      });
      sessionIds.push(id);
      return browserId;
    };

    const profileSaved = (
      browserId: string,
      profileId: string,
      savedAt: string,
      sizeBytes?: number,
    ) => ({
      eventId: uuidv7(),
      eventType: "profile.saved",
      sessionId: browserId,
      profileId,
      savedAt,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      attempt: 0,
    });

    // A null secret omits the header.
    const send = (body: object, secret: string | null = WEBHOOK_SECRET!) => {
      const req = request(TEST_API_URL).post("/v2/browser/webhook/destroyed");
      if (secret !== null) req.set("x-browser-service-secret", secret);
      return req.send(body);
    };

    const profileRow = async (name: string) => {
      const [row] = await db
        .select()
        .from(schema.browser_profiles)
        .where(
          and(
            eq(schema.browser_profiles.team_id, identity.teamId),
            eq(schema.browser_profiles.name, name),
          ),
        );
      return row;
    };

    it("records a saved profile under the session's team", async () => {
      const name = newProfileName();
      const browserId = await createSession(name);

      const res = await send(
        profileSaved(
          browserId,
          browserProfileStorageId(identity.teamId, name),
          "2026-09-22T10:00:00.000Z",
          4096,
        ),
      );
      expect(res.statusCode).toBe(200);

      const row = await profileRow(name);
      expect(row).toBeDefined();
      expect(new Date(row!.saved_at).toISOString()).toBe(
        "2026-09-22T10:00:00.000Z",
      );
      expect(row!.size_bytes).toBe(4096);
    });

    it("keeps the newest save when deliveries arrive out of order", async () => {
      const name = newProfileName();
      const profileId = browserProfileStorageId(identity.teamId, name);
      const first = await createSession(name);
      const second = await createSession(name);

      const newer = await send(
        profileSaved(second, profileId, "2026-09-22T12:00:00.000Z", 9000),
      );
      expect(newer.statusCode).toBe(200);
      // An older save's retry lands after the newer one.
      const older = await send(
        profileSaved(first, profileId, "2026-09-22T11:00:00.000Z", 1000),
      );
      expect(older.statusCode).toBe(200);

      const row = await profileRow(name);
      expect(new Date(row!.saved_at).toISOString()).toBe(
        "2026-09-22T12:00:00.000Z",
      );
      expect(row!.size_bytes).toBe(9000);
    });

    it("rejects a save whose profile id does not match the session", async () => {
      const name = newProfileName();
      const browserId = await createSession(name);

      const res = await send(
        profileSaved(
          browserId,
          browserProfileStorageId(identity.teamId, `${name}-other`),
          "2026-09-22T10:00:00.000Z",
        ),
      );
      expect(res.statusCode).toBe(409);
      expect(await profileRow(name)).toBeUndefined();
    });

    it("ignores saves for unknown sessions and sessions without a profile", async () => {
      const name = newProfileName();
      const profileId = browserProfileStorageId(identity.teamId, name);

      const unknown = await send(
        profileSaved(
          `snips-unknown-${uuidv7()}`,
          profileId,
          "2026-09-22T10:00:00.000Z",
        ),
      );
      expect(unknown.statusCode).toBe(200);

      const withoutProfile = await createSession(null);
      const noProfile = await send(
        profileSaved(withoutProfile, profileId, "2026-09-22T10:00:00.000Z"),
      );
      expect(noProfile.statusCode).toBe(200);

      expect(await profileRow(name)).toBeUndefined();
    });

    it("rejects malformed events and requests without the secret", async () => {
      const name = newProfileName();
      const browserId = await createSession(name);
      const event = profileSaved(
        browserId,
        browserProfileStorageId(identity.teamId, name),
        "2026-09-22T10:00:00.000Z",
      );

      expect((await send({ ...event, savedAt: "yesterday" })).statusCode).toBe(
        400,
      );
      expect((await send(event, null)).statusCode).toBe(401);
      expect((await send(event, "wrong-secret")).statusCode).toBe(401);
      expect(await profileRow(name)).toBeUndefined();
    });
  },
);
