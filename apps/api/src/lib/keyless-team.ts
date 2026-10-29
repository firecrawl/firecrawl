import { v5 as uuidv5 } from "uuid";

// Keyless team ids live here, apart from lib/keyless, so modules that only
// need them do not load its Redis and database clients.

// Keyless teams reuse the `preview_` prefix so billing (autumn `isPreviewTeam`)
// and GCS persistence are skipped automatically, with a dedicated infix so the
// IP can be recovered when charging credits after a request completes.
export const KEYLESS_TEAM_PREFIX = "preview_keyless_";

export function keylessTeamId(ip: string): string {
  return `${KEYLESS_TEAM_PREFIX}${ip}`;
}

// Fixed namespace for deriving a stable per-keyless-team UUID. Tables like
// `scrapes` require a UUID team_id, but keyless teams are `preview_keyless_<ip>`
// strings. Mapping each to a deterministic UUIDv5 keeps rows per-IP-distinct
// (so ownership checks such as interact still isolate keyless users) while
// satisfying the UUID column, unlike the shared preview placeholder.
const KEYLESS_TEAM_UUID_NAMESPACE = "9e6c8f2a-3b1d-4c7e-8a5f-2d4b6e8c0a1f";

/**
 * Deterministic UUID for a keyless team's persisted rows, or null for
 * non-keyless teams (callers then fall back to the raw/placeholder team_id).
 */
export function keylessTeamUuid(
  teamId: string | null | undefined,
): string | null {
  if (!teamId || !teamId.startsWith(KEYLESS_TEAM_PREFIX)) return null;
  return uuidv5(teamId, KEYLESS_TEAM_UUID_NAMESPACE);
}

// Shared team UUID that other preview callers are stored under.
const PREVIEW_TEAM_ID = "3adefd26-77ec-5968-8dcf-c94b5630d1de";

/**
 * The team id to store in a UUID column: a keyless caller's UUID, the shared
 * preview team for other preview callers, or the team id unchanged.
 */
export function persistedTeamId(teamId: string): string {
  return (
    keylessTeamUuid(teamId) ??
    (teamId === "preview" || teamId.startsWith("preview_")
      ? PREVIEW_TEAM_ID
      : teamId)
  );
}
