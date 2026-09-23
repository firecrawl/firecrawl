// Pure helpers for persistent browser profiles, kept free of the DB so the
// scrape engine can import the storage id. The table writes live in
// browser-sessions.ts.
import { createHash } from "crypto";
import { z } from "zod";

/**
 * The id a profile's saved state is stored under in the browser service: the
 * first 16 hex chars of sha256(teamId), then the profile name. /scrape, browser
 * sessions and interact sessions must all derive it the same way, or they read
 * and write different profiles.
 */
export function browserProfileStorageId(teamId: string, name: string): string {
  const teamHash = createHash("sha256")
    .update(teamId)
    .digest("hex")
    .slice(0, 16);
  return `${teamHash}_${name}`;
}

// Sent by the browser service's webhook outbox after it uploads a session's
// profile. It names the browser-service session and the storage id only.
export const profileSavedEventSchema = z.object({
  eventType: z.literal("profile.saved"),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  profileId: z.string().min(1),
  savedAt: z.iso.datetime({ offset: true }),
  sizeBytes: z.number().int().nonnegative().optional(),
});

type ProfileSavedEvent = z.infer<typeof profileSavedEventSchema>;

type ProfileSaveResolution =
  | { action: "upsert"; teamId: string; name: string }
  | { action: "ignore"; reason: "no_profile_name" | "not_a_team" | "deleted" }
  | { action: "reject"; reason: "profile_mismatch" };

// Redis key holding when a profile was last deleted (browser-service clock),
// kept for longer than the browser service retries a profile.saved event.
export function browserProfileDeletedKey(storageId: string): string {
  return `browser-profile-deleted:${storageId}`;
}

/**
 * Decides what a reported save means for the session it came from. The team
 * and profile name come from our own session row, never from the event, and
 * the event's storage id must be the one that row derives. `deletedAt` is when
 * the profile was last deleted, if recently.
 */
export function resolveProfileSave(
  session: { team_id: string; profile_name?: string | null },
  event: Pick<ProfileSavedEvent, "profileId" | "savedAt">,
  deletedAt?: string | null,
): ProfileSaveResolution {
  // Sessions created before profile_name was recorded.
  if (!session.profile_name) {
    return { action: "ignore", reason: "no_profile_name" };
  }
  // Keyless callers (preview_keyless_<ip>) have no teams row to list under.
  if (!z.uuid().safeParse(session.team_id).success) {
    return { action: "ignore", reason: "not_a_team" };
  }
  if (
    browserProfileStorageId(session.team_id, session.profile_name) !==
    event.profileId
  ) {
    return { action: "reject", reason: "profile_mismatch" };
  }
  // A save that finished before the profile was deleted (its event delivered
  // late) must not bring the listing back; a save after the delete does. An
  // unreadable deletion time fails closed.
  if (deletedAt) {
    const deletedMs = Date.parse(deletedAt);
    if (Number.isNaN(deletedMs) || Date.parse(event.savedAt) <= deletedMs) {
      return { action: "ignore", reason: "deleted" };
    }
  }
  return {
    action: "upsert",
    teamId: session.team_id,
    name: session.profile_name,
  };
}
