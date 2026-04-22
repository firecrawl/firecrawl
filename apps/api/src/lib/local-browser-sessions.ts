/**
 * In-memory registry of local browser sessions (backed by the
 * `apps/playwright-service-ts` microservice) keyed by session id, used to
 * enforce ownership by team. This is intentionally per-API-process state: it
 * is sufficient for single-process self-hosted deployments, which is where the
 * local-browser feature is applicable.
 *
 * The map is bounded: when the cap is exceeded (e.g. because clients never
 * explicitly delete sessions and the microservice auto-expires them), the
 * oldest entries (by ``createdAt``) are evicted first. This keeps memory
 * usage bounded for long-running API instances while leaving plenty of room
 * for any realistic concurrent use (the microservice itself caps concurrent
 * sessions at ``LOCAL_BROWSER_MAX_SESSIONS``, default 5).
 */

type LocalBrowserSession = {
  sessionId: string;
  teamId: string;
  createdAt: number;
};

const DEFAULT_OWNERSHIP_MAX = 1000;

const OWNERSHIP_MAX = (() => {
  const raw = Number.parseInt(
    process.env.LOCAL_BROWSER_OWNERSHIP_MAX ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OWNERSHIP_MAX;
})();

// Map iteration order is insertion order, so the first key is always the
// oldest entry. We rely on that for eviction instead of scanning.
const sessions = new Map<string, LocalBrowserSession>();

function evictIfOverCapacity(): void {
  while (sessions.size > OWNERSHIP_MAX) {
    const oldestKey = sessions.keys().next().value;
    if (oldestKey === undefined) break;
    sessions.delete(oldestKey);
  }
}

export function registerLocalBrowserSession(
  sessionId: string,
  teamId: string,
): void {
  sessions.set(sessionId, {
    sessionId,
    teamId,
    createdAt: Date.now(),
  });
  evictIfOverCapacity();
}

export function unregisterLocalBrowserSession(sessionId: string): void {
  sessions.delete(sessionId);
}

type LocalBrowserOwnershipCheck =
  | { kind: "ok" }
  | { kind: "not-found" }
  | { kind: "forbidden" };

export function checkLocalBrowserOwnership(
  sessionId: string,
  teamId: string,
): LocalBrowserOwnershipCheck {
  const session = sessions.get(sessionId);
  if (!session) return { kind: "not-found" };
  if (session.teamId !== teamId) return { kind: "forbidden" };
  return { kind: "ok" };
}
