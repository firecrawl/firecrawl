import { config } from "./config";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { basename, join } from "node:path";
import { HTML_TO_MARKDOWN_PATH } from "./natives";
import { startRole } from "./main";
import { installedService, runProcessStop } from "./service/service";

const childProcesses = new Set<ChildProcess>();
const stopping = new WeakSet<ChildProcess>(); // processes we're intentionally stopping

let IS_DEV = false;
// The file to start a process role with: `node <roleEntry> <role>`.
let roleEntry = "";
let restartSignal: AbortController | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
let nuqPostgresContainer: {
  containerName: string;
  containerRuntime: string;
} | null = null;
let nuqRabbitMQContainer: {
  containerName: string;
  containerRuntime: string;
} | null = null;
let fdbContainer: {
  containerName: string;
  containerRuntime: string;
} | null = null;

// Get the monorepo root for both tsx source execution and compiled dist execution.
// __dirname is available in CommonJS (which this compiles to)
const SOURCE_MONOREPO_ROOT = join(__dirname, "..", "..", "..");
const DIST_MONOREPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MONOREPO_ROOT = existsSync(
  join(SOURCE_MONOREPO_ROOT, "apps", "nuq-postgres"),
)
  ? SOURCE_MONOREPO_ROOT
  : DIST_MONOREPO_ROOT;
const NUQ_POSTGRES_PATH = join(MONOREPO_ROOT, "apps", "nuq-postgres");

interface ProcessResult {
  promise: Promise<void>;
  process: ChildProcess;
}

interface Services {
  api?: ProcessResult;
  worker?: ProcessResult;
  nuqWorkers: Array<ProcessResult>;
  nuqPrefetchWorker?: ProcessResult;
  nuqReconcilerWorker?: ProcessResult;
  extractWorker?: ProcessResult;
  indexWorker?: ProcessResult;
  command?: ProcessResult;
  nuqPostgres?: {
    containerName: string;
    containerRuntime: string;
  };
  nuqRabbitMQ?: {
    containerName: string;
    containerRuntime: string;
  };
  fdb?: {
    containerName: string;
    containerRuntime: string;
  };
}

const colors = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  white: "\u001b[37m",
};

const processGroupColors = new Map<string, string>([
  ["api", colors.green],
  ["worker", colors.blue],
  ["extract", colors.magenta],
  ["nuq", colors.cyan],
  ["index", colors.yellow],
  ["go", colors.yellow],
  ["command", colors.white],
  ["docker", colors.blue],
  ["podman", colors.blue],
]);

function getProcessGroup(name: string): string {
  let group = name;
  if (name.includes("@")) {
    group = name.split("@")[0];
  }
  if (name.includes("-")) {
    group = name.split("-")[0];
  }
  return group;
}

function getProcessColor(name: string): string {
  const group = getProcessGroup(name);
  return processGroupColors.get(group) || colors.gray;
}

function formatDuration(nanoseconds: bigint): string {
  const milliseconds = Number(nanoseconds) / 1e6;
  if (milliseconds < 1000) {
    return `${milliseconds.toFixed(0)}ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

const PORT = config.PORT;
const WORKER_PORT = config.WORKER_PORT;
const NUQ_WORKER_START_PORT = config.NUQ_WORKER_START_PORT;
const NUQ_WORKER_COUNT = config.NUQ_WORKER_COUNT;
const NUQ_PREFETCH_WORKER_PORT = NUQ_WORKER_START_PORT + NUQ_WORKER_COUNT;
const NUQ_RECONCILER_WORKER_PORT = NUQ_PREFETCH_WORKER_PORT + 1;

// PostgreSQL credentials (with defaults for backward compatibility)
const POSTGRES_USER = config.POSTGRES_USER;
const POSTGRES_PASSWORD = config.POSTGRES_PASSWORD;
const POSTGRES_DB = config.POSTGRES_DB;
const POSTGRES_HOST = config.POSTGRES_HOST;
const POSTGRES_PORT = config.POSTGRES_PORT;

// Shell escape helper to prevent command injection
function shellEscape(arg: string): string {
  // Wrap in single quotes and escape any single quotes within
  return `'${arg.replaceAll("'", String.raw`'\''`)}'`;
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
  error(message: string, error?: unknown) {
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

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function waitForPort(
  port: number,
  host: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs = config.HARNESS_STARTUP_TIMEOUT_MS } = options;

    let settled = false;
    let retryTimer: NodeJS.Timeout | null = null;
    let socket: Socket | null = null;

    const done = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;

      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (socket) {
        socket.destroy();
      }
      if (overallTimer) {
        clearTimeout(overallTimer);
      }

      signal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const onAbort = () => done(createAbortError());

    const overallTimer = setTimeout(
      () =>
        done(
          new Error(
            `Port ${port} did not become available within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );

    if (signal?.aborted) {
      done(createAbortError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const check = () => {
      if (settled) {
        return;
      }
      socket = new Socket();
      const retry = () => {
        socket?.destroy();
        if (!settled) {
          retryTimer = setTimeout(check, 250);
        }
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
  command: string | Array<string>,
  env: Record<string, string> = {},
): ProcessResult {
  let child: ChildProcess;
  let displayCommand: string;
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
        buffer + data.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      const lines = newBuffer.split("\n");
      const completeLines = lines.slice(0, -1);
      const remainingBuffer = lines.at(-1) ?? "";

      completeLines.forEach(line => {
        if (line.trim()) {
          logger.processOutput(name, line, isReduceNoise);
        }
      });

      if (isError) {
        stderrBuffer = remainingBuffer;
      } else {
        stdoutBuffer = remainingBuffer;
      }
    };

    child.stdout?.on("data", (data: Buffer | string) =>
      processOutput(
        typeof data === "string" ? data : data.toString("utf8"),
        false,
      ),
    );
    child.stderr?.on("data", (data: Buffer | string) =>
      processOutput(
        typeof data === "string" ? data : data.toString("utf8"),
        true,
      ),
    );

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
      if (stopping.has(child)) {
        resolve();
      } else {
        reject(new Error(`${name} failed to start: ${error.message}`));
      }
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
      } catch {
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
              } catch {
                // Process may have already exited.
              }
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
    } catch {
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
  } catch {
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
  timeoutMs: number = config.HARNESS_STARTUP_TIMEOUT_MS,
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
    } catch {
      // Not ready yet, wait and retry
      await sleep(500);
    }
  }

  throw new Error(`PostgreSQL did not become ready within ${timeoutMs}ms`);
}

async function setupNuqPostgres(): Promise<Services["nuqPostgres"]> {
  // If NUQ_DATABASE_URL is already set, respect it (user's explicit choice)
  if (config.NUQ_DATABASE_URL) {
    logger.info("NUQ_DATABASE_URL is set, skipping container management");
    return undefined;
  }

  // Check if we're running in docker-compose (POSTGRES_HOST is set and not localhost)
  const isDockerCompose = POSTGRES_HOST !== "localhost";

  if (isDockerCompose) {
    // Running in docker-compose: construct URL with proper encoding
    logger.section("Setting up NUQ PostgreSQL connection for docker-compose");
    const dbUrl = `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${encodeURIComponent(POSTGRES_DB)}`;
    config.NUQ_DATABASE_URL = dbUrl;
    config.NUQ_DATABASE_URL_LISTEN = dbUrl;
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
  config.NUQ_DATABASE_URL = dbUrl;
  config.NUQ_DATABASE_URL_LISTEN = dbUrl;
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

async function startNuqRabbitMQContainer(
  runtime: string,
  containerName: string,
): Promise<void> {
  logger.info(`Starting RabbitMQ container: ${containerName}`);
  const start = execForward(
    `${runtime}@start`,
    `${runtime} run -d --name ${containerName} -p 5672:5672 -p 15672:15672 rabbitmq:3-management`,
  );
  await start.promise;
  logger.success(`RabbitMQ container started: ${containerName}`);
}

async function waitForRabbitMQ(
  host: string,
  port: number,
  timeoutMs: number = config.HARNESS_STARTUP_TIMEOUT_MS,
): Promise<void> {
  logger.info("Waiting for RabbitMQ to be ready...");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      // Try to connect to RabbitMQ using amqplib
      const amqp = await import("amqplib");
      const connection = await amqp.connect(`amqp://${host}:${port}`, {
        timeout: 2000,
      });
      await connection.close();

      logger.success("RabbitMQ is ready");
      return;
    } catch {
      // Not ready yet, wait and retry
      await sleep(500);
    }
  }

  throw new Error(`RabbitMQ did not become ready within ${timeoutMs}ms`);
}

async function setupNuqRabbitMQ(): Promise<Services["nuqRabbitMQ"]> {
  // If NUQ_RABBITMQ_URL is already set, respect it (user's explicit choice)
  if (config.NUQ_RABBITMQ_URL) {
    logger.info("NUQ_RABBITMQ_URL is set, skipping container management");
    return undefined;
  }

  // Check if we're running in docker-compose (POSTGRES_HOST is set and not localhost)
  const isDockerCompose = POSTGRES_HOST !== "localhost";

  if (isDockerCompose) {
    // Running in docker-compose: RabbitMQ should be configured externally
    logger.info(
      "Running in docker-compose, skipping RabbitMQ container management",
    );
    return undefined;
  }

  // Running locally: manage container
  logger.section("Setting up NUQ RabbitMQ container");

  const runtime = await detectContainerRuntime();
  if (!runtime) {
    throw new Error(
      "Neither Docker nor Podman found. Please install Docker/Podman or set NUQ_RABBITMQ_URL manually.",
    );
  }

  logger.success(`Using container runtime: ${runtime}`);

  const containerName = "firecrawl-nuq-rabbitmq";

  // Stop and remove any existing container
  await stopAndRemoveContainer(runtime, containerName);

  // Start the container (using stock image, no build needed)
  await startNuqRabbitMQContainer(runtime, containerName);

  // Wait for RabbitMQ to be ready
  await waitForRabbitMQ("localhost", 5672);

  // Set environment variables for the services
  const rabbitUrl = "amqp://localhost:5672";
  config.NUQ_RABBITMQ_URL = rabbitUrl;
  process.env.NUQ_RABBITMQ_URL = rabbitUrl;

  logger.success("NUQ RabbitMQ container is ready");

  const containerInfo = {
    containerName,
    containerRuntime: runtime,
  };

  // Store globally for graceful shutdown
  nuqRabbitMQContainer = containerInfo;

  return containerInfo;
}

const FDB_IMAGE = "foundationdb/foundationdb:7.3.63";

async function waitForFdb(
  runtime: string,
  containerName: string,
  timeoutMs: number = config.HARNESS_STARTUP_TIMEOUT_MS,
): Promise<void> {
  logger.info("Waiting for FoundationDB to be ready...");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const check = execForward(
        `${runtime}@fdb-status`,
        `${runtime} exec ${containerName} fdbcli --exec "status minimal"`,
      );
      await check.promise;
      logger.success("FoundationDB is ready");
      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error(`FoundationDB did not become ready within ${timeoutMs}ms`);
}

async function setupFdb(): Promise<Services["fdb"]> {
  // FDB is only needed when the FDB queue backend is in play
  if (config.NUQ_BACKEND !== "fdb" && !process.env.NUQ_FDB_TESTS) {
    return undefined;
  }

  // If FDB_CLUSTER_FILE is already set, respect it (user's explicit choice)
  if (config.FDB_CLUSTER_FILE) {
    logger.info("FDB_CLUSTER_FILE is set, skipping container management");
    return undefined;
  }

  logger.section("Setting up FoundationDB container");

  const runtime = await detectContainerRuntime();
  if (!runtime) {
    throw new Error(
      "Neither Docker nor Podman found. Please install Docker/Podman or set FDB_CLUSTER_FILE manually.",
    );
  }

  logger.success(`Using container runtime: ${runtime}`);

  const containerName = "firecrawl-fdb";
  await stopAndRemoveContainer(runtime, containerName);

  const start = execForward(
    `${runtime}@start`,
    `${runtime} run -d --name ${containerName} -p 4500:4500 -e FDB_NETWORKING_MODE=host ${FDB_IMAGE}`,
  );
  await start.promise;

  await waitForFdb(runtime, containerName);

  // first boot: create the database; only suppress the known "already
  // configured" failure and surface any real configure error.
  const configure = execForward(
    `${runtime}@fdb-configure`,
    `${runtime} exec ${containerName} sh -c 'out=$(fdbcli --exec "configure new single memory" 2>&1); status=$?; printf "%s\\n" "$out"; if [ "$status" -eq 0 ]; then exit 0; fi; printf "%s\\n" "$out" | grep -Eiq "already.*configured|database.*configured|database.*already exists"'`,
  );
  await configure.promise;

  // the host-side client needs a cluster file pointing at the published port
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const clusterDir = join(tmpdir(), "firecrawl-fdb");
  mkdirSync(clusterDir, { recursive: true });
  const clusterFile = join(clusterDir, "fdb.cluster");
  writeFileSync(clusterFile, "docker:docker@127.0.0.1:4500");

  config.FDB_CLUSTER_FILE = clusterFile;
  process.env.FDB_CLUSTER_FILE = clusterFile;

  logger.success("FoundationDB container is ready");

  const containerInfo = {
    containerName,
    containerRuntime: runtime,
  };
  fdbContainer = containerInfo;
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

async function startServices(command?: Array<string>): Promise<Services> {
  // Setup NUQ PostgreSQL container if needed
  const nuqPostgres = await setupNuqPostgres();

  // Setup NUQ RabbitMQ container if needed
  const nuqRabbitMQ = await setupNuqRabbitMQ();

  // Setup FoundationDB container if the FDB queue backend is enabled
  const fdb = await setupFdb();

  logger.section("Starting services");

  const roleCommand = (role: string, script: string) =>
    process.argv[2] === "--start-docker"
      ? `node ${shellEscape(roleEntry)} ${role}`
      : `pnpm ${script}`;
  const nuqWorkerRole =
    config.NUQ_BACKEND === "fdb" ? "nuq-fdb-worker" : "nuq-worker";

  const api = execForward(
    "api",
    roleCommand("api", "server:production:nobuild"),
    {
      NUQ_REDUCE_NOISE: "true",
      NUQ_POD_NAME: "api",
    },
  );

  const worker = execForward(
    "worker",
    roleCommand("queue-worker", "worker:production"),
    {
      NUQ_REDUCE_NOISE: "true",
      NUQ_POD_NAME: "worker",
      WORKER_PORT: String(WORKER_PORT),
    },
  );

  const roleRunner = /\.(?:[cm]?ts)$/i.test(roleEntry)
    ? "pnpm exec tsx"
    : "node";

  const extractWorker =
    roleEntry && installedService()?.roles.has("extract-worker")
      ? execForward(
          "extract-worker",
          `${roleRunner} ${shellEscape(roleEntry)} extract-worker`,
          process.env.EXTRACT_WORKER_PORT
            ? {
                NUQ_REDUCE_NOISE: "true",
                NUQ_POD_NAME: "extract-worker",
                EXTRACT_WORKER_PORT: process.env.EXTRACT_WORKER_PORT,
              }
            : {
                NUQ_REDUCE_NOISE: "true",
                NUQ_POD_NAME: "extract-worker",
              },
        )
      : undefined;

  const nuqWorkers = Array.from({ length: NUQ_WORKER_COUNT }, (_, i) =>
    execForward(
      `${nuqWorkerRole}-${i}`,
      roleCommand(nuqWorkerRole, `${nuqWorkerRole}:production`),
      {
        NUQ_WORKER_PORT: String(NUQ_WORKER_START_PORT + i),
        NUQ_REDUCE_NOISE: "true",
        NUQ_POD_NAME: `${nuqWorkerRole}-${i}`,
      },
    ),
  );

  const nuqPrefetchWorker =
    config.NUQ_BACKEND === "fdb"
      ? undefined
      : execForward(
          "nuq-prefetch-worker",
          roleCommand("nuq-prefetch-worker", "nuq-prefetch-worker:production"),
          {
            NUQ_PREFETCH_WORKER_PORT: String(NUQ_PREFETCH_WORKER_PORT),
            NUQ_REDUCE_NOISE: "true",
            NUQ_POD_NAME: "nuq-prefetch-worker-0",
            NUQ_PREFETCH_REPLICAS: String(1),
          },
        );

  const nuqReconcilerWorker =
    config.NUQ_BACKEND === "fdb"
      ? undefined
      : execForward(
          "nuq-reconciler",
          roleCommand(
            "nuq-reconciler-worker",
            "nuq-reconciler-worker:production",
          ),
          {
            NUQ_RECONCILER_WORKER_PORT: String(NUQ_RECONCILER_WORKER_PORT),
            NUQ_REDUCE_NOISE: "true",
            NUQ_POD_NAME: "nuq-reconciler-worker-0",
          },
        );

  const indexWorker =
    roleEntry && installedService()?.roles.has("index-worker")
      ? execForward(
          "index-worker",
          `${roleRunner} ${shellEscape(roleEntry)} index-worker`,
          {
            NUQ_REDUCE_NOISE: "true",
            NUQ_POD_NAME: "index-worker",
          },
        )
      : undefined;

  if (
    command &&
    Array.isArray(command) &&
    command[0] === "pnpm" &&
    (command[1].startsWith("test:snips") || command[1] === "exec")
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
    nuqReconcilerWorker,
    indexWorker,
    extractWorker,
    command: commandProcess,
    nuqPostgres,
    nuqRabbitMQ,
    fdb,
  };
}

async function stopDevelopmentServices(services: Services) {
  logger.section("Stopping services");

  const processesToStop: Array<ChildProcess> = [
    services.api?.process,
    services.worker?.process,
    ...services.nuqWorkers.map(w => w.process),
    services.nuqPrefetchWorker?.process,
    services.nuqReconcilerWorker?.process,
    services.indexWorker?.process,
    services.extractWorker?.process,
    services.command?.process,
  ].filter((p): p is ChildProcess => !!p);

  await Promise.all(
    processesToStop.map(proc => terminateProcess(proc, true)),
  ).catch((error: unknown) => {
    logger.error("Error while stopping processes", error);
  });

  // Stop and remove NUQ PostgreSQL container if it was started by harness
  if (services.nuqPostgres) {
    logger.info("Stopping NUQ PostgreSQL container");
    await stopAndRemoveContainer(
      services.nuqPostgres.containerRuntime,
      services.nuqPostgres.containerName,
    );
    logger.success("NUQ PostgreSQL container stopped");
  }

  // Stop and remove NUQ RabbitMQ container if it was started by harness
  if (services.nuqRabbitMQ) {
    logger.info("Stopping NUQ RabbitMQ container");
    await stopAndRemoveContainer(
      services.nuqRabbitMQ.containerRuntime,
      services.nuqRabbitMQ.containerName,
    );
    logger.success("NUQ RabbitMQ container stopped");
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
    if (shuttingDown) {
      return;
    }

    pending = true;
    restartSignal?.abort();

    if (restarting) {
      return;
    }
    restarting = true;

    try {
      while (pending) {
        pending = false;

        if (currentServices) {
          await stopDevelopmentServices(currentServices);
          currentServices = null;
        }

        if (shuttingDown) {
          return;
        }

        currentServices = await startServices();

        restartSignal?.abort();
        restartSignal = new AbortController();

        try {
          await waitForPort(Number(PORT), "localhost", {
            signal: restartSignal?.signal,
          });
        } catch (error: unknown) {
          if (!(error instanceof Error) || error.name !== "AbortError") {
            throw error;
          }
          if (shuttingDown) {
            return;
          }

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

  watch.on("first_success", () => {
    logger.success("Initial compilation complete");
    void restartServices();
  });

  watch.on("success", () => {
    if (started) {
      logger.info("Recompilation complete - restarting services");
      void restartServices();
    }
  });

  watch.on("compile_errors", () => {
    logger.error("Compilation failed - services not restarted");
  });

  logger.section("Starting development mode");
  // The typescript package is aliased to @typescript/typescript6 (which only
  // ships tsc6), so tsc-watch's default typescript/bin/tsc does not resolve;
  // point it at TypeScript 7's tsc explicitly, like the package.json scripts.
  watch.start(
    "--compiler",
    "./node_modules/typescript-7/bin/tsc",
    "--project",
    ".",
  );

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

async function runProductionMode(command: Array<string>): Promise<void> {
  const services = await startServices(command);

  logger.info(`Waiting for API on localhost:${PORT}`);
  await waitForPort(Number(PORT), "localhost");

  await waitForTermination(services);
}

let serviceError = false;

async function waitForTermination(services: Services): Promise<void> {
  logger.info("All services running. Press Ctrl+C to stop");

  const promises: Array<Promise<void>> = [
    new Promise<void>(resolve => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    }),
  ];

  if (services.command) {
    promises.push(services.command.promise);
  }
  if (services.api) {
    promises.push(services.api.promise);
  }
  if (services.worker) {
    promises.push(services.worker.promise);
  }
  if (services.indexWorker) {
    promises.push(services.indexWorker.promise);
  }
  if (services.extractWorker) {
    promises.push(services.extractWorker.promise);
  }
  if (services.nuqPrefetchWorker) {
    promises.push(services.nuqPrefetchWorker.promise);
  }
  if (services.nuqReconcilerWorker) {
    promises.push(services.nuqReconcilerWorker.promise);
  }

  promises.push(...services.nuqWorkers.map(w => w.promise));

  await Promise.race(promises).catch((error: unknown) => {
    logger.error("A service has terminated unexpectedly", error);
    serviceError = true;
  });
}

function gracefulShutdown(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  shuttingDown = true;
  shutdownPromise = (async () => {
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

    // Stop and remove NUQ RabbitMQ container if it was started by harness
    if (nuqRabbitMQContainer) {
      logger.info("Stopping NUQ RabbitMQ container");
      await stopAndRemoveContainer(
        nuqRabbitMQContainer.containerRuntime,
        nuqRabbitMQContainer.containerName,
      );
      logger.success("NUQ RabbitMQ container stopped");
      nuqRabbitMQContainer = null;
    }

    // Stop and remove FoundationDB container if it was started by harness
    if (fdbContainer) {
      logger.info("Stopping FoundationDB container");
      await stopAndRemoveContainer(
        fdbContainer.containerRuntime,
        fdbContainer.containerName,
      );
      logger.success("FoundationDB container stopped");
      fdbContainer = null;
    }

    await runProcessStop("harness");
    logger.success("All processes terminated");
  })();
  return shutdownPromise;
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

function logFatalError(label: string, error: unknown): void {
  logger.error(label);
  if (error instanceof Error) {
    console.error(error.stack || error.message);
  } else {
    console.error(error);
  }
}

function handleShutdownSignal(): void {
  void gracefulShutdown();
}

async function main() {
  process.on("SIGINT", handleShutdownSignal);
  process.on("SIGTERM", handleShutdownSignal);

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
  } catch (error: unknown) {
    logFatalError("Fatal error occurred", error);
    process.exit(1);
  } finally {
    await gracefulShutdown();
    logger.info("Goodbye!");
    process.exit(serviceError ? 1 : 0);
  }
}

process.on("unhandledRejection", reason => {
  logger.error("Unhandled rejection");
  console.error(reason);
  void gracefulShutdown().finally(() => {
    process.exit(1);
  });
});

export async function start(env: { entry: string }) {
  roleEntry = env.entry;
  await main().catch(async (error: unknown) => {
    logFatalError("Fatal error in main", error);
    await gracefulShutdown();
    process.exit(1);
  });
}

if (require.main === module) {
  void startRole("harness");
}
