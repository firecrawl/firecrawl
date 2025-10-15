import "dotenv/config";
import { type ChildProcess, spawn } from "child_process";
import * as net from "net";
import { basename } from "path";
import { HTML_TO_MARKDOWN_PATH } from "./natives";
import { createWriteStream } from "fs";

const childProcesses = new Set<ChildProcess>();
const stopping = new WeakSet<ChildProcess>(); // processes we're intentionally stopping

let IS_DEV = false;
let restartSignal: AbortController | null = null;
let shuttingDown = false;

interface ProcessResult {
  promise: Promise<void>;
  process: ChildProcess;
}

interface Services {
  api?: ProcessResult;
  worker?: ProcessResult;
  nuqWorkers: ProcessResult[];
  nuqPrefetchWorker?: ProcessResult;
  extractWorker?: ProcessResult;
  indexWorker?: ProcessResult;
  command?: ProcessResult;
}

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

const processGroupColors: Record<string, string> = {
  api: colors.green,
  worker: colors.blue,
  extract: colors.magenta,
  nuq: colors.cyan,
  index: colors.yellow,
  go: colors.yellow,
  command: colors.white,
};

function getProcessGroup(name: string): string {
  let group = name;
  if (name.includes("@")) group = name.split("@")[0];
  if (name.includes("-")) group = name.split("-")[0];
  return group;
}

function getProcessColor(name: string): string {
  const group = getProcessGroup(name);
  return processGroupColors[group] || colors.gray;
}

function formatDuration(nanoseconds: bigint): string {
  const milliseconds = Number(nanoseconds) / 1e6;
  if (milliseconds < 1000) return `${milliseconds.toFixed(0)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

const stream = createWriteStream("firecrawl.log");

const PORT = process.env.PORT ?? "3002";
const WORKER_PORT = process.env.WORKER_PORT ?? "3005";
const EXTRACT_WORKER_PORT = process.env.EXTRACT_WORKER_PORT ?? "3004";
const NUQ_WORKER_START_PORT = Number(process.env.NUQ_WORKER_START_PORT ?? "3006");

const logger = {
  section(message: string) {
    console.log(
      `\n${colors.bold}${colors.blue}── ${message} ──${colors.reset}\n`,
    );
  },
  info(message: string) {
    console.log(`${colors.blue}ℹ${colors.reset} ${message}`);
  },
  success(message: string) {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
  },
  warn(message: string) {
    console.log(`${colors.yellow}!${colors.reset} ${message}`);
  },
  error(message: string, error?: any) {
    if (error) {
      console.error(`${colors.red}✗${colors.reset} ${message}`, error);
    } else {
      console.error(`${colors.red}✗${colors.reset} ${message}`);
    }
  },
  processStart(name: string, command: string) {
    const color = getProcessColor(name);
    console.log(
      `${color}>${colors.reset} ${color}${colors.bold}${name.padEnd(14)}${colors.reset} ${colors.dim}${command}${colors.reset}`,
    );
  },
  processEnd(name: string, exitCode: number | null, duration: bigint) {
    const color = getProcessColor(name);
    const symbol = exitCode === 0 ? "●" : "✗";
    const symbolColor = exitCode === 0 ? colors.green : colors.red;
    const timing = `${colors.dim}${formatDuration(duration)}${colors.reset}`;
    const codeInfo =
      exitCode !== 0 ? ` ${colors.red}(${exitCode})${colors.reset}` : "";
    console.log(
      `${symbolColor}${symbol}${colors.reset} ${color}${colors.bold}${name.padEnd(14)}${colors.reset} ${timing}${codeInfo}`,
    );
  },
  processOutput(name: string, line: string, isReduceNoise: boolean) {
    const color = getProcessColor(name);
    if (!(line.includes("[nuq/metrics:") && isReduceNoise)) {
      const label = `${color}${colors.bold}${name.padEnd(14)}${colors.reset}`;
      console.log(`${label} ${line}`);
    }
    stream.write(`${name.padEnd(14)} ${line}\n`);
  },
};

function waitForPort(
  port: number,
  host: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs = 30000 } = options;

    let settled = false;
    let retryTimer: NodeJS.Timeout | null = null;
    let socket: net.Socket | null = null;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;

      if (retryTimer) clearTimeout(retryTimer);
      if (socket) socket.destroy();
      if (overallTimer) clearTimeout(overallTimer);

      signal?.removeEventListener("abort", onAbort);
      err ? reject(err) : resolve();
    };

    const abortError = () => {
      const e = new Error("Aborted");
      (e as any).name = "AbortError";
      return e;
    };
    const onAbort = () => done(abortError());

    const overallTimer = setTimeout(
      () =>
        done(
          new Error(
            `Port ${port} did not become available within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );

    if (signal?.aborted) return done(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });

    const check = () => {
      if (settled) return;
      socket = new net.Socket();
      const retry = () => {
        socket?.destroy();
        if (!settled) retryTimer = setTimeout(check, 250);
      };
      socket.once("error", retry);
      socket.setTimeout(1000, retry);
      socket.connect(port, host, () => done());
    };

    check();
  });
}

function execForward(
  name: string,
  command: string | string[],
  env: Record<string, string> = {},
): ProcessResult {
  let child: ChildProcess;
  let displayCommand = "";
  const isWindows = process.platform === "win32";

  const isReduceNoise = env.NUQ_REDUCE_NOISE === "true";
  delete env.NUQ_REDUCE_NOISE;

  if (typeof command === "string") {
    displayCommand = command;
    if (isWindows) {
      child = spawn("cmd", ["/c", command], {
        env: { ...process.env, ...env },
        shell: false,
        detached: false,
      });
    } else {
      child = spawn("sh", ["-c", command], {
        env: { ...process.env, ...env },
        shell: false,
        detached: true,
      });
    }
  } else {
    const [cmd, ...args] = command;
    displayCommand = [cmd, ...args].join(" ");
    child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      shell: false,
      detached: !isWindows,
    });
  }

  logger.processStart(name, displayCommand);
  childProcesses.add(child);

  const startTime = process.hrtime.bigint();
  const promise = new Promise<void>((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const processOutput = (data: string, isError = false) => {
      const buffer = isError ? stderrBuffer : stdoutBuffer;
      const newBuffer =
        buffer + data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = newBuffer.split("\n");
      const completeLines = lines.slice(0, -1);
      const remainingBuffer = lines[lines.length - 1];

      completeLines.forEach(line => {
        if (line.trim()) logger.processOutput(name, line, isReduceNoise);
      });

      if (isError) stderrBuffer = remainingBuffer;
      else stdoutBuffer = remainingBuffer;
    };

    child.stdout?.on("data", data => processOutput(data.toString(), false));
    child.stderr?.on("data", data => processOutput(data.toString(), true));

    child.on("close", code => {
      childProcesses.delete(child);
      logger.processEnd(name, code, process.hrtime.bigint() - startTime);
      const wasStopping = stopping.has(child);
      if (code !== 0 && !wasStopping) {
        reject(new Error(`${name} failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    child.on("error", error => {
      childProcesses.delete(child);
      logger.processEnd(name, -1, process.hrtime.bigint() - startTime);
      if (stopping.has(child)) resolve();
      else reject(new Error(`${name} failed to start: ${error.message}`));
    });
  });

  return { promise, process: child };
}

function terminateProcess(proc: ChildProcess, force: boolean): Promise<void> {
  return new Promise(resolve => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }

    stopping.add(proc);

    let killTimeout: NodeJS.Timeout | null = null;

    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }

      if (killTimeout) {
        clearTimeout(killTimeout);
        killTimeout = null;
      }
    };

    proc.once("close", cleanup);
    proc.once("error", cleanup);

    const isWindows = process.platform === "win32";

    if (isWindows && proc.pid) {
      const killer = spawn(
        "taskkill",
        ["/pid", proc.pid.toString(), "/t", "/f"],
        {
          stdio: "ignore",
        },
      );
      killer.on("exit", cleanup);
    } else if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch (e) {
        proc.kill("SIGTERM");
      }

      // for the old workers, if they are mid-job it will wait for them to finish
      // for dev mode for now we can just kill them (jobs will be picked up again if required)
      if (force && IS_DEV) {
        killTimeout = setTimeout(() => {
          if (proc.pid) {
            logger.warn(
              `Process ${proc.pid} did not exit in time, forcing termination`,
            );

            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {
              try {
                proc.kill("SIGKILL");
              } catch {}
            }
          }
        }, 5000);
      }
    }
  });
}

async function installDependencies() {
  logger.section("Installing dependencies");

  const tasks = [
    (async () => {
      if (
        process.argv[2] !== "--start-built" &&
        process.argv[2] !== "--start-docker"
      ) {
        logger.info("Installing API dependencies");
        const install = execForward("api@install", "pnpm install");
        await install.promise;

        logger.info("Building API");
        const build = execForward("api@build", "pnpm build");
        await build.promise;
      } else {
        logger.warn("Skipping API install and build");
      }
    })(),

    (async () => {
      logger.info("Installing Go dependencies");
      const install = execForward(
        "go@install",
        "cd sharedLibs/go-html-to-md && go mod tidy",
      );
      await install.promise;

      logger.info("Building Go module");
      const build = execForward(
        "go@build",
        `cd sharedLibs/go-html-to-md && go build -o ${basename(HTML_TO_MARKDOWN_PATH)} -buildmode=c-shared html-to-markdown.go`,
      );
      await build.promise;
    })(),
  ];

  await Promise.all(tasks);
  logger.success("Dependencies installed");
}

function startServices(command?: string[]): Services {
  logger.section("Starting services");

  const api = execForward(
    "api",
    process.argv[2] === "--start-docker"
      ? "node --import ./dist/src/otel.js dist/src/index.js"
      : "pnpm server:production:nobuild",
    {
      NUQ_REDUCE_NOISE: "true",
      NUQ_POD_NAME: "api",
    },
  );

  const worker = execForward(
    "worker",
    process.argv[2] === "--start-docker"
      ? "node --import ./dist/src/otel.js dist/src/services/queue-worker.js"
      : "pnpm worker:production",
    {
      NUQ_REDUCE_NOISE: "true",
      NUQ_POD_NAME: "worker",
      WORKER_PORT: WORKER_PORT,
    },
  );

  const extractWorker = execForward(
    "extract-worker",
    process.argv[2] === "--start-docker"
      ? "node --import ./dist/src/otel.js dist/src/services/extract-worker.js"
      : "pnpm extract-worker:production",
    {
      NUQ_REDUCE_NOISE: "true",
      NUQ_POD_NAME: "extract-worker",
      EXTRACT_WORKER_PORT: EXTRACT_WORKER_PORT,
    },
  );

  const nuqWorkers = Array.from({ length: 5 }, (_, i) =>
    execForward(
      `nuq-worker-${i}`,
      process.argv[2] === "--start-docker"
        ? "node --import ./dist/src/otel.js dist/src/services/worker/nuq-worker.js"
        : "pnpm nuq-worker:production",
      {
        NUQ_WORKER_PORT: String(NUQ_WORKER_START_PORT + i),
        NUQ_REDUCE_NOISE: "true",
        NUQ_POD_NAME: `nuq-worker-${i}`,
      },
    ),
  );

  const nuqPrefetchWorker = process.env.NUQ_RABBITMQ_URL
    ? execForward(
        "nuq-prefetch-worker",
        process.argv[2] === "--start-docker"
          ? "node --import ./dist/src/otel.js dist/src/services/worker/nuq-prefetch-worker.js"
          : "pnpm nuq-prefetch-worker:production",
        {
          NUQ_PREFETCH_WORKER_PORT: String(3011),
          NUQ_REDUCE_NOISE: "true",
          NUQ_POD_NAME: "nuq-prefetch-worker",
        },
      )
    : undefined;

  const indexWorker =
    process.env.USE_DB_AUTHENTICATION === "true"
      ? execForward(
          "index-worker",
          process.argv[2] === "--start-docker"
            ? "node --import ./dist/src/otel.js dist/src/services/indexing/index-worker.js"
            : "pnpm index-worker:production",
          {
            NUQ_REDUCE_NOISE: "true",
            NUQ_POD_NAME: "index-worker",
          },
        )
      : undefined;

  const commandProcess =
    command && !command?.[0].startsWith("--")
      ? execForward("command", command)
      : undefined;

  return {
    api,
    worker,
    nuqWorkers,
    nuqPrefetchWorker,
    indexWorker,
    extractWorker,
    command: commandProcess,
  };
}

async function stopDevelopmentServices(services: Services) {
  logger.section("Stopping services");

  const processesToStop: ChildProcess[] = [
    services.api?.process,
    services.worker?.process,
    ...services.nuqWorkers.map(w => w.process),
    services.nuqPrefetchWorker?.process,
    services.indexWorker?.process,
    services.extractWorker?.process,
    services.command?.process,
  ].filter((p): p is ChildProcess => !!p);

  await Promise.race([
    await Promise.all(
      processesToStop.map(proc => terminateProcess(proc, true)),
    ).catch(e => {
      logger.error("Error while stopping processes", e);
    }),
  ]);
}

async function runDevMode(): Promise<void> {
  let currentServices: Services | null = null;

  let started = false;
  let restarting = false;
  let pending = false;

  const { TscWatchClient } = await import("tsc-watch");
  const watch = new TscWatchClient();

  const restartServices = async () => {
    if (shuttingDown) return;

    pending = true;
    restartSignal?.abort();

    if (restarting) return;
    restarting = true;

    try {
      while (pending) {
        pending = false;

        if (currentServices) {
          await stopDevelopmentServices(currentServices);
          currentServices = null;
        }

        if (shuttingDown) return;

        currentServices = startServices();

        restartSignal?.abort();
        restartSignal = new AbortController();

        try {
          await waitForPort(Number(PORT), "localhost", {
            signal: restartSignal?.signal,
          });
        } catch (e) {
          if (e?.name !== "AbortError") throw e;
          if (shuttingDown) return;

          logger.section(
            "Recompilation triggering during restart, trying again...",
          );
          continue;
        }

        logger.success("All services started");
        started = true;
      }
    } finally {
      restarting = false;
    }
  };

  watch.on("started", () => {
    logger.info("TypeScript compilation started");
    pending = true;
    restartSignal?.abort();
  });

  watch.on("first_success", async () => {
    logger.success("Initial compilation complete");
    await restartServices();
  });

  watch.on("success", async () => {
    if (started) {
      logger.info("Recompilation complete - restarting services");
      await restartServices();
    }
  });

  watch.on("compile_errors", () => {
    logger.error("Compilation failed - services not restarted");
  });

  logger.section("Starting development mode");
  watch.start("--project", ".");

  await new Promise<void>(resolve => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  restartSignal?.abort();
  if (currentServices) {
    await stopDevelopmentServices(currentServices);
  }
  watch.kill();
}

async function runProductionMode(command: string[]): Promise<void> {
  const services = startServices(command);

  logger.info(`Waiting for API on localhost:${PORT}`);
  await waitForPort(Number(PORT), "localhost");

  await waitForTermination(services);
}

async function waitForTermination(services: Services): Promise<void> {
  logger.info("All services running. Press Ctrl+C to stop");

  const promises: Promise<void>[] = [
    new Promise<void>(resolve => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    }),
  ];

  if (services.command) promises.push(services.command.promise);
  if (services.api) promises.push(services.api.promise);
  if (services.worker) promises.push(services.worker.promise);
  if (services.indexWorker) promises.push(services.indexWorker.promise);
  if (services.extractWorker) promises.push(services.extractWorker.promise);
  if (services.nuqPrefetchWorker)
    promises.push(services.nuqPrefetchWorker.promise);

  promises.push(...services.nuqWorkers.map(w => w.promise));

  await Promise.race(promises);
}

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  restartSignal?.abort();

  logger.section("Shutting down");
  const forceTerminate = IS_DEV;
  const terminationPromises = Array.from(childProcesses).map(proc =>
    terminateProcess(proc, forceTerminate),
  );
  await Promise.all(terminationPromises);
  logger.success("All processes terminated");
}

function printUsage() {
  console.error(
    `${colors.bold}Usage:${colors.reset} pnpm harness <command...>\n`,
  );
  console.error(`${colors.bold}Special commands:${colors.reset}`);
  console.error(
    `  --start        Start in development mode (auto-restart on changes)`,
  );
  console.error(`  --start-built  Start services without rebuilding`);
  console.error(`  --start-docker Start services (skip install, assume built)`);
}

async function main() {
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  try {
    if (process.argv.length < 3) {
      printUsage();
      process.exit(1);
    }

    const command = process.argv.slice(2);
    IS_DEV = command[0] === "--start";

    if (command[0] !== "--start-docker") {
      await installDependencies();
    }

    if (IS_DEV) {
      await runDevMode();
    } else {
      await runProductionMode(command);
    }
  } catch (error: any) {
    logger.error("Fatal error occurred");
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  } finally {
    await gracefulShutdown();
    logger.info("Goodbye!");
    process.exit(0);
  }
}

process.on("unhandledRejection", async (reason, promise) => {
  logger.error("Unhandled rejection");
  console.error(reason);
  await gracefulShutdown();
  process.exit(1);
});

main().catch(async error => {
  logger.error("Fatal error in main");
  console.error(error?.stack || error?.message || error);
  await gracefulShutdown();
  process.exit(1);
});
