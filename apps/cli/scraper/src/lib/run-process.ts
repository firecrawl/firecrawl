import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface RunProcessOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  /** Called for every stdout and stderr line, e.g. to parse progress. */
  onLine?: ((line: string, stream: "stdout" | "stderr") => void) | undefined;
}

export class ProcessError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly output: string,
  ) {
    super(`${command} exited with ${code ?? "a signal"}${output ? `: ${output}` : ""}`);
  }
}

const TAIL_LINES = 20;

/**
 * Run a command without a shell, streaming its output lines. Rejects with the
 * last lines of output on a non-zero exit; aborting the signal kills the child.
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  opts: RunProcessOptions = {},
): Promise<void> {
  opts.signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    signal: opts.signal,
    killSignal: "SIGTERM",
  });
  const tail: string[] = [];
  const watch = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr"): void => {
    createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      opts.onLine?.(line, name);
    });
  };
  watch(child.stdout, "stdout");
  watch(child.stderr, "stderr");
  await new Promise<void>((resolve, reject) => {
    child.once("error", (err) => {
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${command} not found`) : err,
      );
    });
    child.once("close", (code) => {
      if (opts.signal?.aborted) reject(opts.signal.reason);
      else if (code === 0) resolve();
      else reject(new ProcessError(command, code, tail.join("\n").trim()));
    });
  });
}
