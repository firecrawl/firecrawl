import {
  browserProfileStorageId,
  profileSavedEventSchema,
  resolveProfileSave,
} from "./browser-profiles";

const TEAM = "00000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "00000000-0000-4000-8000-000000000002";

describe("browserProfileStorageId", () => {
  it("prefixes the name with the first 16 hex chars of sha256(teamId)", () => {
    expect(browserProfileStorageId(TEAM, "my-profile")).toBe(
      "11e594f481958c10_my-profile",
    );
    expect(browserProfileStorageId(OTHER_TEAM, "my-profile")).toBe(
      "e79acd97ac880866_my-profile",
    );
  });

  it("keeps the name verbatim, underscores included", () => {
    expect(browserProfileStorageId(TEAM, "a_b c")).toBe(
      "11e594f481958c10_a_b c",
    );
  });
});

describe("profileSavedEventSchema", () => {
  const event = {
    eventId: "a4f5c6a0-4c1f-4a7f-9d0b-3e0f1d2c3b4a",
    eventType: "profile.saved",
    sessionId: "bs_123",
    profileId: "11e594f481958c10_my-profile",
    savedAt: "2026-09-22T19:30:00.000Z",
    sizeBytes: 48213,
    attempt: 2,
  };

  it("accepts the event the browser service sends", () => {
    expect(profileSavedEventSchema.parse(event)).toMatchObject({
      sessionId: "bs_123",
      profileId: "11e594f481958c10_my-profile",
      savedAt: "2026-09-22T19:30:00.000Z",
      sizeBytes: 48213,
    });
  });

  it("accepts an event without a size", () => {
    const { sizeBytes: _, ...withoutSize } = event;
    expect(profileSavedEventSchema.safeParse(withoutSize).success).toBe(true);
  });

  it.each([
    ["another event type", { eventType: "session.ended" }],
    ["a missing savedAt", { savedAt: undefined }],
    ["a savedAt that is not a timestamp", { savedAt: "yesterday" }],
    ["a negative size", { sizeBytes: -1 }],
    ["a fractional size", { sizeBytes: 1.5 }],
    ["an empty profile id", { profileId: "" }],
  ])("rejects %s", (_, override) => {
    expect(
      profileSavedEventSchema.safeParse({ ...event, ...override }).success,
    ).toBe(false);
  });
});

describe("resolveProfileSave", () => {
  const profileId = browserProfileStorageId(TEAM, "my-profile");
  const savedAt = "2026-09-22T12:00:00.000Z";
  const session = { team_id: TEAM, profile_name: "my-profile" };

  it("upserts under the session's own team and profile name", () => {
    expect(resolveProfileSave(session, { profileId, savedAt })).toEqual({
      action: "upsert",
      teamId: TEAM,
      name: "my-profile",
    });
  });

  it("ignores sessions that recorded no profile name", () => {
    for (const profile_name of [null, undefined]) {
      expect(
        resolveProfileSave(
          { team_id: TEAM, profile_name },
          { profileId, savedAt },
        ),
      ).toEqual({ action: "ignore", reason: "no_profile_name" });
    }
  });

  it("ignores keyless callers, which have no team to list under", () => {
    const keylessTeam = "preview_keyless_203.0.113.7";
    expect(
      resolveProfileSave(
        { team_id: keylessTeam, profile_name: "my-profile" },
        {
          profileId: browserProfileStorageId(keylessTeam, "my-profile"),
          savedAt,
        },
      ),
    ).toEqual({ action: "ignore", reason: "not_a_team" });
  });

  it("rejects a storage id that belongs to another team", () => {
    expect(
      resolveProfileSave(session, {
        profileId: browserProfileStorageId(OTHER_TEAM, "my-profile"),
        savedAt,
      }),
    ).toEqual({ action: "reject", reason: "profile_mismatch" });
  });

  it("rejects a storage id for a different profile name", () => {
    expect(
      resolveProfileSave(session, {
        profileId: browserProfileStorageId(TEAM, "other-profile"),
        savedAt,
      }),
    ).toEqual({ action: "reject", reason: "profile_mismatch" });
  });

  it("ignores a save from before the profile was deleted", () => {
    for (const deletedAt of [savedAt, "2026-09-22T12:00:01.000Z"]) {
      expect(
        resolveProfileSave(session, { profileId, savedAt }, deletedAt),
      ).toEqual({ action: "ignore", reason: "deleted" });
    }
  });

  it("fails closed on an unreadable deletion time", () => {
    expect(
      resolveProfileSave(session, { profileId, savedAt }, "not-a-time"),
    ).toEqual({ action: "ignore", reason: "deleted" });
  });

  it("records a save made after the profile was deleted", () => {
    expect(
      resolveProfileSave(
        session,
        { profileId, savedAt },
        "2026-09-22T11:59:59.000Z",
      ),
    ).toEqual({ action: "upsert", teamId: TEAM, name: "my-profile" });
  });
});
