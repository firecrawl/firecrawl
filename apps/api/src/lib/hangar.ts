import { config } from "../config";

export interface HangarBrowser {
  id: string;
  status:
    | "starting"
    | "running"
    | "suspending"
    | "suspended"
    | "resuming"
    | "stopping"
    | "stopped"
    | "failed";
  created_at: number;
  ended_at: number | null;
  max_expires_at: number | null;
  recording: boolean;
  profile_saved_at?: number | null;
  error?: string | null;
}

interface HangarCreated extends HangarBrowser {
  cdp_url: string;
  view_url?: string;
  control_url?: string;
  playlist_url?: string;
}

export interface BrowserExecutionResult {
  stdout: string;
  result: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
  truncated?: boolean;
}

export class HangarError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: {
    key?: string;
    timeout?: number;
    resource?: "browsers" | "profiles";
  },
): Promise<T> {
  if (!config.HANGAR_URL)
    throw new HangarError(
      503,
      "Browser feature is not configured (HANGAR_URL is missing).",
    );
  let response: globalThis.Response;
  try {
    response = await fetch(
      `${config.HANGAR_URL.replace(/\/$/, "")}/v1/${options?.resource ?? "browsers"}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(options?.key ? { "Idempotency-Key": options.key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options?.timeout ?? 40_000),
      },
    );
  } catch {
    throw new HangarError(502, "Hangar is unavailable.");
  }
  // Do not expose upstream bodies: creation failures can contain capability URLs.
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HangarError(
      response.status,
      response.status === 409
        ? "Browser operation conflicts with the current session or profile state."
        : "Hangar request failed.",
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new HangarError(502, "Invalid Hangar response.");
  }
}

export const getHangarBrowser = (id: string, wait = 0, timeout?: number) =>
  request<HangarBrowser>(
    "GET",
    `/${encodeURIComponent(id)}${wait ? `?wait=${wait}` : ""}`,
    undefined,
    { timeout },
  );
export const stopHangarBrowser = (id: string) =>
  request<HangarBrowser>("POST", `/${encodeURIComponent(id)}/stop`);

export async function createHangarBrowser(
  key: string,
  teamId: string,
  options: {
    ttl: number;
    activityTtl: number;
    streamWebView: boolean;
    recordSession: boolean;
    profile?: { name: string; saveChanges: boolean };
  },
): Promise<HangarCreated> {
  const body = {
    owner: teamId,
    max_lifetime_seconds: options.ttl,
    idle_timeout_seconds: options.activityTtl,
    live_view: {
      enabled: options.streamWebView,
      interactive: options.streamWebView,
    },
    recording: { enabled: options.recordSession },
    execution: { enabled: true },
    ...(options.profile
      ? {
          profile: {
            name: options.profile.name,
            save_changes: options.profile.saveChanges,
          },
        }
      : {}),
  };
  let created: HangarCreated | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      created = await request<HangarCreated>("POST", "?wait=30", body, { key });
      break;
    } catch (error) {
      if (
        !(error instanceof HangarError) ||
        error.status < 500 ||
        attempt === 2
      )
        throw error;
    }
  }
  if (!created?.id)
    throw new HangarError(502, "Invalid Hangar creation response.");
  try {
    if (!created.cdp_url)
      throw new HangarError(502, "Invalid Hangar creation response.");
    let browser: HangarBrowser = created;
    const deadline = Date.now() + 300_000;
    while (browser.status === "starting" && Date.now() < deadline)
      browser = await getHangarBrowser(created.id, 30);
    if (browser.status !== "running")
      throw new HangarError(502, "Browser failed to become ready.");
    return { ...created, ...browser };
  } catch (error) {
    await stopHangarBrowser(created.id).catch(() => {});
    throw error;
  }
}

export async function executeHangarBrowser(
  id: string,
  params: {
    code: string;
    language: string;
    timeout: number;
  },
): Promise<BrowserExecutionResult> {
  const { code, language, timeout } = params;
  const result = await request<
    Omit<BrowserExecutionResult, "exitCode"> & { exit_code: number }
  >(
    "POST",
    `/${encodeURIComponent(id)}/execute`,
    { code, language, timeout },
    { timeout: (timeout + 20) * 1000 },
  );
  const { exit_code, ...output } = result;
  return { ...output, exitCode: exit_code };
}

export async function deleteHangarProfile(owner: string, name: string) {
  const result = await request<{ deleted_at?: unknown }>(
    "DELETE",
    `/${encodeURIComponent(name)}?owner=${encodeURIComponent(owner)}`,
    undefined,
    { resource: "profiles" },
  );
  // Compared against Hangar save timestamps during reconciliation.
  const deletedAt =
    typeof result.deleted_at === "number"
      ? new Date(result.deleted_at * 1000)
      : new Date(NaN);
  if (Number.isNaN(deletedAt.getTime()))
    throw new HangarError(502, "Invalid Hangar profile deletion response.");
  return { deletedAt: deletedAt.toISOString() };
}

/** Keep the replay API's HLS response while letting players fetch segments from Hangar. */
export async function getHangarRecording(playlistUrl: string) {
  const unavailable = () =>
    new HangarError(502, "Failed to fetch session replay.");
  let response: globalThis.Response;
  let base: URL;
  try {
    base = new URL(playlistUrl);
    if (!["http:", "https:"].includes(base.protocol)) throw unavailable();
    response = await fetch(base.href, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw unavailable();
  }
  if (!response.ok) await response.body?.cancel().catch(() => {});
  if ([401, 404, 409, 410].includes(response.status))
    throw new HangarError(404, "Replay not found.");
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw unavailable();
      chunks.push(value);
    }
  } catch {
    throw unavailable();
  } finally {
    await reader.cancel().catch(() => {});
  }
  const lines = Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/);
  if (lines[0] !== "#EXTM3U") throw unavailable();
  let durationMs = 0;
  let pendingDuration: number | undefined;
  let segments = 0;
  const playlist =
    lines
      .map(line => {
        if (line.startsWith("#EXTINF:")) {
          const match = /^#EXTINF:(\d+(?:\.\d+)?),/.exec(line);
          if (!match || pendingDuration !== undefined) throw unavailable();
          pendingDuration = Number(match[1]) * 1000;
          if (!Number.isFinite(pendingDuration) || pendingDuration <= 0)
            throw unavailable();
        } else if (line && !line.startsWith("#")) {
          if (pendingDuration === undefined) throw unavailable();
          let segment: URL;
          try {
            segment = new URL(line, base);
          } catch {
            throw unavailable();
          }
          if (segment.origin !== base.origin) throw unavailable();
          durationMs += pendingDuration;
          pendingDuration = undefined;
          segments++;
          return segment.href;
        }
        return line;
      })
      .join("\n") + "\n";
  if (!segments || pendingDuration !== undefined) throw unavailable();
  return { playlist, durationMs: Math.round(durationMs) };
}
