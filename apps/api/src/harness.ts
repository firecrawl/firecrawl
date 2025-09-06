import "dotenv/config";
import { exec } from "child_process";
import * as net from "net";
import { basename } from "path";
import { HTML_TO_MARKDOWN_PATH } from "./natives";

function waitForPort(port: number, host: string): Promise<void> {
  return new Promise(resolve => {
    const checkPort = () => {
      const socket = new net.Socket();

      const onError = () => {
        socket.destroy();
        setTimeout(checkPort, 1000); // Try again in 1 second
      };

      socket.once("error", onError);

      socket.connect(port, host, () => {
        socket.destroy();
        resolve();
      });
    };

    checkPort();
  });
}

if (process.argv.length < 3) {
  console.error("Usage: pnpm harness <command...>");
  console.error();
  console.error(
    "The harness ensures that the dependencies are up to date, everything is built, and the API and Worker are running, before running a command that would require the above.",
  );
  console.error(
    "It also tears down the API and Worker after the command is run.",
  );
  process.exit(1);
}

const command = process.argv.slice(2);

function execForward(
  fancyName: string,
  command: string,
  env: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = exec(command, {
      env: { ...process.env, ...env },
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    child.stdout?.on("data", data => {
      stdoutBuffer += data;
      while (stdoutBuffer.includes("\n")) {
        const split = stdoutBuffer.split("\n");
        const line = split[0];
        stdoutBuffer = split.slice(1).join("\n");
        process.stdout.write(`[${fancyName}] ${line}\n`);
      }
    });
    child.stderr?.on("data", data => {
      stderrBuffer += data;
      while (stderrBuffer.includes("\n")) {
        const split = stderrBuffer.split("\n");
        const line = split[0];
        stderrBuffer = split.slice(1).join("\n");
        process.stderr.write(`[${fancyName}] ${line}\n`);
      }
    });
    child.on("close", code => {
      if (code !== 0) {
        reject(
          new Error(
            `Command ${JSON.stringify(command)} failed with code ${code}`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

(async () => {
  if (process.argv[2] !== "--start-docker") {
    console.log("=== Installing dependencies and building all components...");
    await Promise.all([
      (async () => {
        if (process.argv[2] !== "--start-built") {
          const install = execForward("api@install", "pnpm install");
          await install;

          const build = execForward("api@build", "pnpm build");
          await build;
        } else {
          console.log("=== Skipping install and build, using built files...");
        }
      })(),
      (async () => {
        const install = execForward(
          "sharedLibs/go-html-to-md@install",
          "cd sharedLibs/go-html-to-md && go mod tidy",
        );
        await install;

        const build = execForward(
          "sharedLibs/go-html-to-md@build",
          `cd sharedLibs/go-html-to-md && go build -o ${basename(HTML_TO_MARKDOWN_PATH)} -buildmode=c-shared html-to-markdown.go`,
        );
        await build;
      })(),
    ]);
  }

  console.log("=== Starting API, Worker, and Index Worker...");

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
  const nuqWorkers = new Array(5).fill(0).map((_, i) =>
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

  try {
    await Promise.race([
      waitForPort(3002, "localhost"),
      new Promise(reject =>
        setTimeout(() => reject(new Error("API did not start in time")), 10000),
      ),
    ]);

    if (
      process.argv[2] === "--start" ||
      process.argv[2] === "--start-built" ||
      process.argv[2] === "--start-docker"
    ) {
      console.log(
        "=== Everything is up and running, waiting for termination or failure...",
      );
      await Promise.race([
        new Promise(resolve => {
          process.on("SIGINT", resolve);
          process.on("SIGTERM", resolve);
        }),
        api,
        worker,
        ...nuqWorkers,
        ...(indexWorker ? [indexWorker] : []),
      ]);
    } else {
      console.log("=== Running command...");
      const cmd = execForward("command", command.join(" "));
      await Promise.race([
        cmd,
        api,
        worker,
        ...nuqWorkers,
        ...(indexWorker ? [indexWorker] : []),
      ]);
    }
  } finally {
    console.log("=== Tearing down API, Worker, and Index Worker...");
    exec("pkill -f 'queue-worker.js'");
    exec("pkill -f 'index.js'");
    if (indexWorker) {
      exec("pkill -f 'index-worker.js'");
    }
    exec("pkill -f 'nuq-worker.js'");
    await Promise.all([
      api,
      worker,
      ...nuqWorkers,
      ...(indexWorker ? [indexWorker] : []),
    ]);
  }

  console.log("=== Goodbye!");
})();
