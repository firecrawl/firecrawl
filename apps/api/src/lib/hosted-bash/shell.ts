import type { InitialFiles } from "just-bash";
import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { docsFiles } from "./docs";
import type { FirecrawlCaller } from "./firecrawl-command";
import { MAX_FIRECRAWL_CALLS, TIMEOUT_MS } from "./limits";
import type {
  ParentMessage,
  SandboxResult,
  ShellJob,
  WorkerMessage,
} from "./shell-worker";

// Compiled, this is shell-worker.js; under tsx or vitest it is the .ts source.
const WORKER_FILE = join(__dirname, `shell-worker${extname(__filename)}`);
const MAX_SHELLS = 4;
const HEAP_MB = 192;
// Under tsx the transpiler alone holds about 200 MB.
const MAX_RSS_KB = (WORKER_FILE.endsWith(".ts") ? 576 : 320) * 1024;
const RSS_POLL_MS = 50;
const KILL_GRACE_MS = 2_000;
const DOCS_WAIT_MS = 5_000;

let running = 0;

/** Every shell slot on this server is taken. */
export class ShellBusyError extends Error {}

export interface ShellResult extends SandboxResult {
  durationMs: number;
}

type Caller = Omit<FirecrawlCaller, "maxCalls" | "deadline">;

/**
 * Runs one command in a fresh shell in its own process, so a command that
 * spins or runs out of memory only costs that process, killed at the deadline.
 * A worker thread is not enough: one huge allocation aborts the whole process.
 */
export async function runShell(
  command: string,
  caller: Caller,
  signal: AbortSignal,
): Promise<ShellResult> {
  if (running >= MAX_SHELLS) throw new ShellBusyError();
  running++;
  try {
    const started = Date.now();
    const deadline = started + TIMEOUT_MS;
    const docs = await Promise.race([
      docsFiles(),
      new Promise<InitialFiles>(resolve =>
        setTimeout(() => resolve({}), DOCS_WAIT_MS).unref(),
      ),
      new Promise<InitialFiles>(resolve => {
        if (signal.aborted) resolve({});
        signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
    ]);
    if (signal.aborted) {
      return {
        stdout: "",
        stderr: "bash: the request was closed\n",
        exitCode: 130,
        truncated: false,
        endpoints: [],
        failedEndpoints: [],
        durationMs: Date.now() - started,
      };
    }
    const job: ShellJob = {
      command,
      caller: { ...caller, maxCalls: MAX_FIRECRAWL_CALLS, deadline },
      docs: Object.keys(docs),
      deadline,
    };
    return await new Promise<ShellResult>(resolve => {
      const child = fork(WORKER_FILE, [], {
        env: {},
        execArgv: [
          `--max-old-space-size=${HEAP_MB}`,
          ...(WORKER_FILE.endsWith(".ts") ? ["--require", "tsx/cjs"] : []),
        ],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let settled = false;
      const send = (message: ParentMessage) => {
        if (!settled && child.connected) child.send(message);
      };
      const finish = (result: SandboxResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        signal.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        resolve({ ...result, durationMs: Date.now() - started });
      };
      const fail = (exitCode: number, message: string) =>
        finish({
          stdout: "",
          stderr: `bash: ${message}\n`,
          exitCode,
          truncated: false,
          endpoints: [],
          failedEndpoints: [],
        });
      const timer = setTimeout(
        () =>
          fail(
            124,
            `execution exceeded the ${TIMEOUT_MS / 1000} second deadline`,
          ),
        deadline + KILL_GRACE_MS - Date.now(),
      );
      const onAbort = () => fail(130, "the request was closed");
      signal.addEventListener("abort", onAbort);
      // The heap flag misses large strings, so resident memory is watched too.
      // Linux only; elsewhere the read fails and the heap flag is the only cap.
      const watch = setInterval(() => {
        readFile(`/proc/${child.pid}/status`, "utf8").then(
          status => {
            const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
            if (rss > MAX_RSS_KB) fail(1, "memory limit exceeded");
          },
          () => {},
        );
      }, RSS_POLL_MS);

      child.on("message", (message: WorkerMessage) => {
        if (message.type === "done") return finish(message.result);
        const read = docs[message.path] as (() => Promise<string>) | undefined;
        (read ? read() : Promise.reject(new Error("No such file"))).then(
          text => send({ type: "doc", id: message.id, text }),
          (error: Error) =>
            send({ type: "doc", id: message.id, error: error.message }),
        );
      });
      child.on("error", error => fail(1, error.message));
      // V8 aborts the process when the command outgrows its heap.
      child.on("exit", (code, killSignal) =>
        fail(
          1,
          killSignal === "SIGABRT" || code === 134
            ? "memory limit exceeded"
            : "the shell stopped unexpectedly",
        ),
      );
      send({ type: "job", job });
    });
  } finally {
    running--;
  }
}
