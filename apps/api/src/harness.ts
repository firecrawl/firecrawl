import "dotenv/config";
import { type ChildProcess, spawn } from "child_process";
import * as net from "net";
import { basename } from "path";
import { HTML_TO_MARKDOWN_PATH } from "./natives";

const childProcesses = new Set<ChildProcess>();

interface ProcessResult {
  promise: Promise<void>;
  process: ChildProcess;
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
  nuq: colors.cyan,
  index: colors.magenta,
  go: colors.yellow,
  command: colors.white,
};

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
  return processGroupColors[group] || colors.gray;
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

const logger = {
  section(message: string) {
    console.log(
      `\n${colors.bold}${colors.blue}━━ ${message} ━━${colors.reset}\n`,
    );
  },

  info(message: string) {
    console.log(message);
  },

  success(message: string) {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
  },

  warn(message: string) {
    console.log(`${colors.yellow}!${colors.reset} ${message}`);
  },

  error(message: string) {
    console.error(`${colors.red}✗${colors.reset} ${message}`);
  },

  processStart(name: string, command: string) {
    const color = getProcessColor(name);
    console.log(
      `${color}>${colors.reset} ${color}${colors.bold}${name}${colors.reset} ${colors.dim}${command}${colors.reset}`,
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
      `${symbolColor}${symbol}${colors.reset} ${color}${colors.bold}${name}${colors.reset} ${timing}${codeInfo}`,
    );
  },

  processOutput(name: string, line: string) {
    const color = getProcessColor(name);
    const label = `${color}${name.padEnd(12)}${colors.reset}`;
    console.log(`${label} ${line}`);
  },
};

function waitForPort(
  port: number,
  host: string,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Port ${port} did not become available within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    const checkPort = () => {
      const socket = new net.Socket();
      const onError = () => {
        socket.destroy();
        setTimeout(checkPort, 250);
      };
      socket.once("error", onError);
      socket.setTimeout(1000);
      socket.connect(port, host, () => {
        socket.destroy();
        clearTimeout(timeout);
        resolve();
      });
    };
    checkPort();
  });
}

function execForward(
  name: string,
  command: string | string[],
  env: Record<string, string> = {},
): ProcessResult {
  let child: ChildProcess;
  let displayCommand = "";

  if (typeof command === "string") {
    displayCommand = command;
    const isWindows = process.platform === "win32";
    if (isWindows) {
      child = spawn("cmd", ["/c", command], {
        env: { ...process.env, ...env },
        shell: false,
      });
    } else {
      child = spawn("sh", ["-c", command], {
        env: { ...process.env, ...env },
        shell: false,
      });
    }
  } else {
    const [cmd, ...args] = command;
    displayCommand = [cmd, ...args].join(" ");
    child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      shell: false,
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
        if (line.trim()) {
          logger.processOutput(name, line);
        }
      });

      if (isError) {
        stderrBuffer = remainingBuffer;
      } else {
        stdoutBuffer = remainingBuffer;
      }
    };

    child.stdout?.on("data", data => processOutput(data.toString(), false));
    child.stderr?.on("data", data => processOutput(data.toString(), true));

    child.on("close", code => {
      childProcesses.delete(child);
      logger.processEnd(name, code, process.hrtime.bigint() - startTime);
      if (code !== 0) {
        reject(new Error(`${name} failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    child.on("error", error => {
      childProcesses.delete(child);
      logger.processEnd(name, -1, process.hrtime.bigint() - startTime);
      reject(new Error(`${name} failed to start: ${error.message}`));
    });
  });

  return { promise, process: child };
}

function terminateProcess(proc: any): Promise<void> {
  return new Promise(resolve => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }

    let resolved = false;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    proc.on("close", resolveOnce);
    proc.on("exit", resolveOnce);
    proc.on("error", resolveOnce);

    try {
      proc.kill("SIGTERM");
    } catch {
      resolveOnce();
      return;
    }

    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
      resolveOnce();
    }, 5000);
  });
}

let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.section("Shutting down");
  const terminationPromises = Array.from(childProcesses).map(terminateProcess);
  await Promise.all(terminationPromises);
  logger.success("All processes terminated");
}

async function buildDependencies() {
  logger.section("Build");

  const tasks = [
    (async () => {
      if (process.argv[2] !== "--start-built") {
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
        "go-html-to-md@install",
        "cd sharedLibs/go-html-to-md && go mod tidy",
      );
      await install.promise;

      logger.info("Building Go module");
      const build = execForward(
        "go-html-to-md@build",
        `cd sharedLibs/go-html-to-md && go build -o ${basename(HTML_TO_MARKDOWN_PATH)} -buildmode=c-shared html-to-markdown.go`,
      );
      await build.promise;
    })(),
  ];

  await Promise.all(tasks);
  logger.success("Build completed");
}

async function startServices() {
  logger.section("Starting services");

  const api = execForward(
    "api",
    process.argv[2] === "--start-docker"
      ? "node dist/src/index.js"
      : "pnpm server:production:nobuild",
  );

  const worker = execForward(
    "worker",
    process.argv[2] === "--start-docker"
      ? "node dist/src/services/queue-worker.js"
      : "pnpm worker:production",
  );

  const nuqWorkers = Array.from({ length: 5 }, (_, i) =>
    execForward(
      `nuq-worker-${i}`,
      process.argv[2] === "--start-docker"
        ? "node dist/src/services/worker/nuq-worker.js"
        : "pnpm nuq-worker:production",
      {
        NUQ_WORKER_PORT: String(3006 + i),
        NUQ_REDUCE_NOISE: "true",
      },
    ),
  );

  const indexWorker =
    process.env.USE_DB_AUTHENTICATION === "true"
      ? execForward(
          "index-worker",
          process.argv[2] === "--start-docker"
            ? "node dist/src/services/indexing/index-worker.js"
            : "pnpm index-worker:production",
        )
      : null;

  logger.info("Waiting for API on localhost:3002");
  await waitForPort(3002, "localhost");
  logger.success("API is ready");

  return {
    api: api.promise,
    worker: worker.promise,
    nuqWorkers: nuqWorkers.map(w => w.promise),
    indexWorker: indexWorker?.promise,
  };
}

async function runCommand(command: string[], services: any) {
  logger.section(`Running: ${command.join(" ")}`);
  const cmd = execForward("command", command);
  await Promise.race([
    cmd.promise,
    services.api,
    services.worker,
    ...services.nuqWorkers,
    ...(services.indexWorker ? [services.indexWorker] : []),
  ]);
}

async function waitForTermination(services: any) {
  logger.info("All services running. Press Ctrl+C to stop");
  await Promise.race([
    new Promise<void>(resolve => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    }),
    services.api,
    services.worker,
    ...services.nuqWorkers,
    ...(services.indexWorker ? [services.indexWorker] : []),
  ]);
}

function printUsage() {
  console.error(
    `${colors.bold}Usage:${colors.reset} pnpm harness <command...>\n`,
  );
  console.error(`${colors.bold}Special commands:${colors.reset}`);
  console.error(`  --start        Start services and wait for termination`);
  console.error(`  --start-built  Start services without rebuilding`);
  console.error(`  --start-docker Start services (skip build completely)\n`);
  console.error(
    `The harness ensures dependencies are installed, everything is built,`,
  );
  console.error(`and services are running before executing your command.`);
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
    const isStartCommand = [
      "--start",
      "--start-built",
      "--start-docker",
    ].includes(command[0]);

    if (command[0] !== "--start-docker") {
      await buildDependencies();
    }

    const services = await startServices();

    if (isStartCommand) {
      await waitForTermination(services);
    } else {
      await runCommand(command, services);
    }
  } catch (error: any) {
    logger.error("Fatal error occurred");
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  } finally {
    await gracefulShutdown();
    logger.info("Goodbye!");
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
