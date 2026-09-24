# Browser and interact on Hangar

`/v2/browser` and `/v2/interact` share the same Hangar adapter. Firecrawl authenticates requests and retains ownership, billing, concurrency, request logs and the scrape-to-session association. Hangar owns browser lifecycle, execution, profiles, viewer access and recording delivery. Prompt-based scrape interaction still uses Firecrawl's agent loop over Hangar execution.

Creation returns `cdpUrl`, optional `liveViewUrl`, optional `interactiveLiveViewUrl`, and optional `playlistUrl`. These are Hangar's capability URLs, unchanged. Viewer credentials use URL fragments; recording credentials are in the path. Do not strip or reconstruct them. Disabled features omit their links. The existing unused `context_id` session column stores the playlist URL; no database migration is needed.

`GET /v2/{browser|interact}/:sessionId/replay` now returns `{ success: true, playlistUrl }`, including after stop. Open the URL directly in an HLS player. Hangar records the whole Chrome window, so there is no per-tab replay list or Firecrawl playlist proxy. The old `/replay/:pageId` routes are removed. Hangar returns 409 until the first recording segment is available and retains playback for 24 hours after termination.

DELETE accepts Hangar's asynchronous stop and returns `status: "stopping"` with `cleanupQueued: true`. Poll `GET /v2/{browser|interact}/:sessionId` for lifecycle state and settled billing. Duration and credits are returned once terminal state is confirmed. The index worker reconciles expiry and unattended termination every 15 seconds. A database row lock serializes settlement across replicas; Firebill retries use a stable session charge ID. Transient billing failures remain retryable.

Profiles keep the existing `{ name, saveChanges }` request shape. Hangar scopes them to the authenticated team, allows one writer, permits concurrent readers, and persists Chrome's user-data directory. Existing profiles in the old browser service are not automatically imported.

## Rollout

1. Deploy Hangar's profile-capable guest image and API with lifecycle timestamps. Configure a private `HANGAR_PROFILE_BUCKET` with GCS object read/write access for the API. See Hangar's `docs/profiles.md` for storage and failure behavior.
2. Allow the Firecrawl API and index worker to reach the internal Hangar API through the service network policy. Set `HANGAR_URL` to its origin. Hangar's internal API intentionally has no application authentication.
3. Drain old browser-service sessions before switching. `BROWSER_SERVICE_URL`, its API key and destroyed-webhook secret are no longer used.
4. Run the browser-replay and scrape-browser snips against the configured services. The profile case requires the profile bucket. Fire-engine-dependent scrape cases and AI cases retain their suite gates.

Execution forwards only code, language and timeout. Hangar enforces timeout and returns stdout, stderr, result, exit status, killed and truncated flags. Execution is never retried after an ambiguous response. Node and Python bindings are persistent and use Patchright; page-global JavaScript replay explicitly uses the main world.
