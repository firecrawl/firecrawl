/* eslint-disable no-await-in-loop -- readiness checks wait for the previous attempt. */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
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

export async function ensureApiReady(apiUrl: string, signal?: AbortSignal): Promise<void> {
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
  process.stderr.write("Local API unavailable; starting Docker Compose…\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["compose", "up", "--build", "-d"], {
      cwd: checkoutRoot(),
      stdio: "inherit",
      env: { ...process.env, PORT: url.port || "80" },
      ...(signal ? { signal } : {}),
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Docker Compose exited with ${code}`)),
    );
  });
  process.stderr.write(
    "Docker services started and will remain running. Stop them with task down.\n",
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy(apiUrl, signal, true)) return;
    await sleep(1000, undefined, { signal });
  }
  throw new Error("API did not become ready within 120 seconds; inspect task logs:api");
}
