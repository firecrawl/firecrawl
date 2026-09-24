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
  error?: string | null;
}

export interface HangarCreated extends HangarBrowser {
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
  options?: { key?: string; timeout?: number },
): Promise<T> {
  if (!config.HANGAR_URL)
    throw new HangarError(
      503,
      "Browser feature is not configured (HANGAR_URL is missing).",
    );
  let response: globalThis.Response;
  try {
    response = await fetch(
      `${config.HANGAR_URL.replace(/\/$/, "")}/v1/browsers${path}`,
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
  if (!response.ok)
    throw new HangarError(
      response.status,
      response.status === 409
        ? "Browser operation conflicts with the current session or profile state."
        : "Hangar request failed.",
    );
  try {
    return (await response.json()) as T;
  } catch {
    throw new HangarError(502, "Invalid Hangar response.");
  }
}

export const getHangarBrowser = (id: string, wait = 0) =>
  request<HangarBrowser>(
    "GET",
    `/${encodeURIComponent(id)}${wait ? `?wait=${wait}` : ""}`,
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
  if (!created?.id || !created.cdp_url)
    throw new HangarError(502, "Invalid Hangar creation response.");
  try {
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
    origin?: string;
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
