import "dotenv/config";
import { type ChildProcess, spawn } from "child_process";
import * as net from "net";
import { basename, join } from "path";
import { HTML_TO_MARKDOWN_PATH } from "./natives";

const childProcesses = new Set<ChildProcess>();
const stopping = new WeakSet<ChildProcess>(); // processes we're intentionally stopping

let IS_DEV = false;
let restartSignal: AbortController | null = null;
let shuttingDown = false;
let nuqPostgresContainer: {
  containerName: string;
  containerRuntime: string;
} | null = null;

// Get the monorepo root (apps/api/dist/src -> ../../../..)
// __dirname is available in CommonJS (which this compiles to)
const MONOREPO_ROOT = join(__dirname, "..", "..", "..", "..");
const NUQ_POSTGRES_PATH = join(MONOREPO_ROOT, "apps", "nuq-postgres");

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
  nuqPostgres?: {
    containerName: string;
    containerRuntime: string;
  };
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
  docker: colors.blue,
  podman: colors.blue,
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

const PORT = process.env.PORT ?? "3002";
const WORKER_PORT = process.env.WORKER_PORT ?? "3005";
const EXTRACT_WORKER_PORT = process.env.EXTRACT_WORKER_PORT ?? "3004";
const NUQ_WORKER_START_PORT = Number(
  process.env.NUQ_WORKER_START_PORT ?? "3006",
);
const NUQ_WORKER_COUNT = Number(process.env.NUQ_WORKER_COUNT ?? "5");
const NUQ_PREFETCH_WORKER_PORT = NUQ_WORKER_START_PORT + NUQ_WORKER_COUNT;

// PostgreSQL credentials (with defaults for backward compatibility)
const POSTGRES_USER = process.env.POSTGRES_USER ?? "postgres";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "postgres";
const POSTGRES_DB = process.env.POSTGRES_DB ?? "postgres";
const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "localhost";
const POSTGRES_PORT = process.env.POSTGRES_PORT ?? "5432";

// Shell escape helper to prevent command injection
function shellEscape(arg: string): string {
  // Wrap in single quotes and escape any single quotes within
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

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

async function detectContainerRuntime(): Promise<string | null> {
  // Try docker first, then podman
  for (const runtime of ["docker", "podman"]) {
    try {
      const check = execForward(`${runtime}@check`, `${runtime} --version`);
      await check.promise;
      return runtime;
    } catch {
      // Runtime not available, try next
    }
  }
  return null;
}

async function isContainerRunning(
  runtime: string,
  containerName: string,
): Promise<boolean> {
  try {
    const check = execForward(
      `${runtime}@ps`,
      `${runtime} ps -a --filter name=^${containerName}$ --format '{{.Names}}'`,
    );
    await check.promise;
    return true;
  } catch {
    return false;
  }
}

async function stopAndRemoveContainer(
  runtime: string,
  containerName: string,
): Promise<void> {
  const isRunning = await isContainerRunning(runtime, containerName);
  if (isRunning) {
    logger.info(`Stopping existing container: ${containerName}`);
    try {
      const stop = execForward(
        `${runtime}@stop`,
        `${runtime} stop ${containerName}`,
      );
      await stop.promise;
    } catch (e) {
      logger.warn(`Failed to stop container ${containerName}, continuing...`);
    }
  }

  // Try to remove the container (whether it was running or not)
  try {
    const remove = execForward(
      `${runtime}@rm`,
      `${runtime} rm -f ${containerName}`,
    );
    await remove.promise;
  } catch (e) {
    // Container might not exist, that's fine
  }
}

async function buildNuqPostgresImage(runtime: string): Promise<void> {
  logger.info("Building nuq-postgres Docker image");
  const build = execForward(
    `${runtime}@build`,
    `${runtime} build -t firecrawl-nuq-postgres:latest ${NUQ_POSTGRES_PATH}`,
  );
  await build.promise;
  logger.success("nuq-postgres image built");
}

async function startNuqPostgresContainer(
  runtime: string,
  containerName: string,
): Promise<void> {
  logger.info(`Starting PostgreSQL container: ${containerName}`);
  const start = execForward(
    `${runtime}@start`,
    `${runtime} run -d --name ${containerName} -p 5432:5432 -e POSTGRES_PASSWORD=${shellEscape(POSTGRES_PASSWORD)} -e POSTGRES_USER=${shellEscape(POSTGRES_USER)} -e POSTGRES_DB=${shellEscape(POSTGRES_DB)} firecrawl-nuq-postgres:latest`,
  );
  await start.promise;
  logger.success(`PostgreSQL container started: ${containerName}`);
}

async function waitForPostgres(
  host: string,
  port: number,
  timeoutMs: number = 30000,
): Promise<void> {
  logger.info("Waiting for PostgreSQL to be ready...");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      // Try to connect to PostgreSQL using a simple query
      const { Client } = await import("pg");
      const client = new Client({
        host,
        port,
        user: POSTGRES_USER,
        password: POSTGRES_PASSWORD,
        database: POSTGRES_DB,
        connectionTimeoutMillis: 2000,
      });

      await client.connect();
      await client.query("SELECT 1");
      await client.end();

      logger.success("PostgreSQL is ready");
      return;
    } catch (e) {
      // Not ready yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw new Error(`PostgreSQL did not become ready within ${timeoutMs}ms`);
}

async function setupNuqPostgres(): Promise<Services["nuqPostgres"]> {
  // If NUQ_DATABASE_URL is already set, respect it (user's explicit choice)
  if (process.env.NUQ_DATABASE_URL) {
    logger.info("NUQ_DATABASE_URL is set, skipping container management");
    return undefined;
  }

  // Check if we're running in docker-compose (POSTGRES_HOST is set and not localhost)
  const isDockerCompose = POSTGRES_HOST !== "localhost";

  if (isDockerCompose) {
    // Running in docker-compose: construct URL with proper encoding
    logger.section("Setting up NUQ PostgreSQL connection for docker-compose");
    const dbUrl = `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${encodeURIComponent(POSTGRES_DB)}`;
    process.env.NUQ_DATABASE_URL = dbUrl;
    process.env.NUQ_DATABASE_URL_LISTEN = dbUrl;
    logger.success(
      "NUQ PostgreSQL connection configured with encoded credentials",
    );
    return undefined;
  }

  // Running locally: manage container
  logger.section("Setting up NUQ PostgreSQL container");

  const runtime = await detectContainerRuntime();
  if (!runtime) {
    throw new Error(
      "Neither Docker nor Podman found. Please install Docker/Podman or set NUQ_DATABASE_URL manually.",
    );
  }

  logger.success(`Using container runtime: ${runtime}`);

  const containerName = "firecrawl-nuq-postgres";

  // Stop and remove any existing container
  await stopAndRemoveContainer(runtime, containerName);

  // Build the image
  await buildNuqPostgresImage(runtime);

  // Start the container
  await startNuqPostgresContainer(runtime, containerName);

  // Wait for PostgreSQL to be ready
  await waitForPostgres("localhost", 5432);

  // Set environment variables for the services with proper encoding
  const dbUrl = `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@localhost:5432/${encodeURIComponent(POSTGRES_DB)}`;
  process.env.NUQ_DATABASE_URL = dbUrl;
  process.env.NUQ_DATABASE_URL_LISTEN = dbUrl;

  logger.success("NUQ PostgreSQL container is ready");

  const containerInfo = {
    containerName,
    containerRuntime: runtime,
  };

  // Store globally for graceful shutdown
  nuqPostgresContainer = containerInfo;

  return containerInfo;
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

async function startServices(command?: string[]): Promise<Services> {
  // Setup NUQ PostgreSQL container if needed
  const nuqPostgres = await setupNuqPostgres();

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

  const nuqWorkers = Array.from({ length: NUQ_WORKER_COUNT }, (_, i) =>
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
          NUQ_PREFETCH_WORKER_PORT: String(NUQ_PREFETCH_WORKER_PORT),
          NUQ_REDUCE_NOISE: "true",
          NUQ_POD_NAME: "nuq-prefetch-worker-0",
          NUQ_PREFETCH_REPLICAS: String(1),
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

  // tests hammer the API instantly, so we need to ensure it's running before launching tests
  if (
    command &&
    Array.isArray(command) &&
    command[0] === "pnpm" &&
    command[1].startsWith("test:snips")
  ) {
    logger.info(`Waiting for API on localhost:${PORT}`);
    await waitForPort(Number(PORT), "localhost");
  }

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
    nuqPostgres,
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

  // Stop and remove NUQ PostgreSQL container if it was started by harness
  if (services.nuqPostgres) {
    logger.info("Stopping NUQ PostgreSQL container");
    await stopAndRemoveContainer(
      services.nuqPostgres.containerRuntime,
      services.nuqPostgres.containerName,
    );
    logger.success("NUQ PostgreSQL container stopped");
  }
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

        currentServices = await startServices();

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
  const services = await startServices(command);

  logger.info(`Waiting for API on localhost:${PORT}`);
  await waitForPort(Number(PORT), "localhost");

  await waitForTermination(services);
}

let serviceError = false;

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

  await Promise.race(promises).catch(error => {
    logger.error("A service has terminated unexpectedly", error);
    serviceError = true;
  });
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
  await Promise.allSettled(terminationPromises);

  // Stop and remove NUQ PostgreSQL container if it was started by harness
  if (nuqPostgresContainer) {
    logger.info("Stopping NUQ PostgreSQL container");
    await stopAndRemoveContainer(
      nuqPostgresContainer.containerRuntime,
      nuqPostgresContainer.containerName,
    );
    logger.success("NUQ PostgreSQL container stopped");
    nuqPostgresContainer = null;
  }

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
    process.exit(serviceError ? 1 : 0);
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
