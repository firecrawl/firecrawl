/* eslint-disable no-await-in-loop -- readiness checks wait for the previous attempt. */
import { setTimeout as sleep } from "node:timers/promises";
import type { StepEvent } from "../lib/progress.js";
import { runProcess } from "../lib/run-process.js";
import { checkoutRoot } from "./paths.js";

async function healthy(url: string, signal?: AbortSignal, starting = false): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const response = await fetch(url.replace(/\/$/, "") + "/", {
      signal: AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]),
    });
    await response.body?.cancel();
    if (!response.ok && starting) return false;
    if (!response.ok) throw new Error(`API health check returned HTTP ${response.status}`);
    return true;
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof Error && err.message.startsWith("API health check")) throw err;
    return false;
  }
}

/**
 * Make sure the API answers, starting the local Docker Compose stack when it
 * is down. Progress and Compose output go to `onEvent`, never the terminal,
 * so a live dashboard stays intact.
 */
export async function ensureApiReady(
  apiUrl: string,
  signal?: AbortSignal,
  onEvent: (event: StepEvent) => void = () => {},
): Promise<void> {
  if (await healthy(apiUrl, signal)) return;
  const url = new URL(apiUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error(
      `API unavailable at ${apiUrl}; automatic startup only supports a local HTTP API`,
    );
  }
  onEvent({ type: "step", label: "Local API unavailable; starting Docker Compose…" });
  await runProcess("docker", ["compose", "up", "--build", "-d"], {
    cwd: checkoutRoot(),
    env: { ...process.env, PORT: url.port || "80" },
    signal,
    onLine: (line) => onEvent({ type: "log", line }),
  });
  onEvent({
    type: "step",
    label: "Docker services started and will remain running. Stop them with task down.",
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy(apiUrl, signal, true)) return;
    await sleep(1000, undefined, { signal });
  }
  throw new Error("API did not become ready within 120 seconds; inspect task logs:api");
}
