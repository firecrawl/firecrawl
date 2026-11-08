import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "../lib/which.js";

export interface CdpCheck {
  ok: boolean;
  /** e.g. "Chrome/141.0.7390.54" when connected. */
  browser?: string | undefined;
  error?: string | undefined;
}

/** Ask a DevTools endpoint for its version, the same check as `curl $url/json/version`. */
export async function checkCdp(
  cdpUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<CdpCheck> {
  try {
    const response = await fetchImpl(new URL("/json/version", cdpUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = (await response.json()) as { Browser?: string };
    return { ok: true, browser: body.Browser };
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    return { ok: false, error: cause ?? (err instanceof Error ? err.message : String(err)) };
  }
}

/** The README's dedicated profile: log in there once and the sessions persist. */
export const CHROME_PROFILE = join(homedir(), ".scraper-chrome");

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

export interface ChromeLaunch {
  command: string;
  args: string[];
}

/** How to start a dedicated Chrome with a debugging port; undefined when the URL is not local. */
export function chromeLaunch(
  cdpUrl: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ChromeLaunch | undefined {
  const url = new URL(cdpUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
  const command =
    platform === "darwin"
      ? existsSync(MAC_CHROME)
        ? MAC_CHROME
        : undefined
      : LINUX_CHROMES.map((name) => findOnPath(name, env)).find(Boolean);
  if (!command) return undefined;
  return {
    command,
    args: [
      `--remote-debugging-port=${url.port || "9222"}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
}

/**
 * Start Chrome detached, so it outlives the scraper and keeps its logins, then
 * wait until the DevTools endpoint answers.
 */
export async function startChrome(cdpUrl: string, waitMs = 15_000): Promise<CdpCheck> {
  const launch = chromeLaunch(cdpUrl);
  if (!launch)
    return {
      ok: false,
      error: `Cannot start Chrome for ${cdpUrl}: it is not a local URL or Chrome is not installed`,
    };
  const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
  const failed = new Promise<CdpCheck>((resolve) => {
    child.once("error", (err) => resolve({ ok: false, error: err.message }));
  });
  child.unref();
  const deadline = Date.now() + waitMs;
  const poll = async (): Promise<CdpCheck> => {
    const check = await checkCdp(cdpUrl);
    if (check.ok || Date.now() > deadline) return check;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return poll();
  };
  return Promise.race([failed, poll()]);
}
