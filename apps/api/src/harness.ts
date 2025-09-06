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
        setTimeout(checkPort, 1000);
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

  if (typeof command === "string") {
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
    child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      shell: false,
    });
  }

  childProcesses.add(child);

  const promise = new Promise<void>((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const processOutput = (data: string, isError = false) => {
      const buffer = isError ? stderrBuffer : stdoutBuffer;
      const newBuffer = buffer + data;
      const lines = newBuffer.split("\n");
      const completeLines = lines.slice(0, -1);
      const remainingBuffer = lines[lines.length - 1];

      completeLines.forEach(line => {
        const output = isError ? process.stderr : process.stdout;
        output.write(`[${name}] ${line}\n`);
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
      if (code !== 0) {
        reject(new Error(`${name} failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    child.on("error", error => {
      childProcesses.delete(child);
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
    } catch (error) {
      resolveOnce();
      return;
    }

    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch (error) {
          // process already dead
        }
      }
      resolveOnce();
    }, 5000);
  });
}

async function gracefulShutdown() {
  console.log("=== Shutting down all processes...");
  const terminationPromises = Array.from(childProcesses).map(terminateProcess);
  await Promise.all(terminationPromises);
  console.log("=== All processes terminated");
}

async function buildDependencies() {
  console.log("=== Installing dependencies and building components...");

  const tasks = [
    (async () => {
      if (process.argv[2] !== "--start-built") {
        console.log("Installing API dependencies...");
        const install = execForward("api@install", "pnpm install");
        await install.promise;

        console.log("Building API...");
        const build = execForward("api@build", "pnpm build");
        await build.promise;
      } else {
        console.log("Skipping API install and build...");
      }
    })(),

    (async () => {
      console.log("Installing Go dependencies...");
      const install = execForward(
        "go-html-to-md@install",
        "cd sharedLibs/go-html-to-md && go mod tidy",
      );
      await install.promise;

      console.log("Building Go module...");
      const build = execForward(
        "go-html-to-md@build",
        `cd sharedLibs/go-html-to-md && go build -o ${basename(HTML_TO_MARKDOWN_PATH)} -buildmode=c-shared html-to-markdown.go`,
      );
      await build.promise;
    })(),
  ];

  await Promise.all(tasks);
  console.log("=== Build completed successfully");
}

async function startServices() {
  console.log("=== Starting services...");

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

  console.log("Waiting for API to start...");
  await waitForPort(3002, "localhost");
  console.log("=== API is ready");

  return {
    api: api.promise,
    worker: worker.promise,
    nuqWorkers: nuqWorkers.map(w => w.promise),
    indexWorker: indexWorker?.promise,
  };
}

async function runCommand(command: string[], services: any) {
  console.log(`=== Running command: ${command.join(" ")}`);

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
  console.log("=== All services running. Press Ctrl+C to stop...");

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
  console.error("Usage: pnpm harness <command...>");
  console.error();
  console.error("Special commands:");
  console.error("  --start        Start services and wait for termination");
  console.error("  --start-built  Start services without rebuilding");
  console.error("  --start-docker Start services (skip build completely)");
  console.error();
  console.error(
    "The harness ensures dependencies are installed, everything is built,",
  );
  console.error("and services are running before executing your command.");
}

async function main() {
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
  process.on("beforeExit", () => {
    void gracefulShutdown();
  });

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
  } catch (error) {
    console.error("=== Error occurred:");
    console.error(error);
    process.exit(1);
  } finally {
    await gracefulShutdown();
    console.log("=== Goodbye!");
  }
}

process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  await gracefulShutdown();
  process.exit(1);
});

main().catch(async error => {
  console.error("Fatal error in main:", error);
  await gracefulShutdown();
  process.exit(1);
});
