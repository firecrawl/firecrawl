import { spawn, type ChildProcess } from "child_process";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const workerPaths = [
  "index.js",
  "services/queue-worker.js",
  "services/extract-worker.js",
  "services/worker/nuq-worker.js",
  "services/worker/nuq-prefetch-worker.js",
  "services/worker/nuq-reconciler-worker.js",
];

const workerSource = `
const name = process.env.NUQ_POD_NAME;
process.on("SIGTERM", () => setTimeout(() => {
  console.log("fixture-stopped:" + name);
  process.exit(0);
}, name === "worker" ? 300 : 0));
process.on("SIGUSR1", () => process.exit(2));
if (name === "api" && process.env.FIXTURE_API_READY === "true") {
  require("net").createServer(socket => socket.end()).listen(Number(process.env.PORT));
}
console.log("fixture-ready:" + name + ":" + process.pid);
setInterval(() => {}, 1000);
`;

describe.skipIf(process.platform === "win32")("harness shutdown", () => {
  let harnessSource: string;
  let directory: string;
  let harness: ChildProcess;
  let output: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(__dirname, "harness.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["tsc-watch"],
      write: false,
    });
    harnessSource = result.outputFiles[0].text;
  });

  afterEach(async () => {
    for (const match of output?.matchAll(/fixture-ready:[\w-]+:(\d+)/g) ?? []) {
      try {
        process.kill(Number(match[1]), "SIGKILL");
      } catch {}
    }
    harness?.kill("SIGKILL");
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function startHarness(apiReady: boolean) {
    directory = await mkdtemp(join(tmpdir(), "harness-shutdown-"));
    output = "";
    await writeFile(join(directory, "harness.cjs"), harnessSource);
    await Promise.all(
      workerPaths.map(async path => {
        const destination = join(directory, "dist/src", path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, workerSource);
      }),
    );

    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing TCP port");
    const port = address.port;
    await new Promise<void>(resolve => server.close(() => resolve()));

    harness = spawn(
      process.execPath,
      [join(directory, "harness.cjs"), "--start-docker"],
      {
        cwd: directory,
        env: {
          PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
          PORT: String(port),
          NUQ_DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
          NUQ_RABBITMQ_URL: "amqp://localhost",
          NUQ_WORKER_COUNT: "1",
          USE_DB_AUTHENTICATION: "false",
          FIXTURE_API_READY: String(apiReady),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    harness.stdout?.on("data", chunk => {
      output += chunk;
    });
    harness.stderr?.on("data", chunk => {
      output += chunk;
    });
    await vi.waitFor(
      () => {
        expect(output.match(/fixture-ready:/g), output).toHaveLength(
          workerPaths.length,
        );
        expect(output).toContain(
          apiReady ? "All services running" : "Waiting for API",
        );
      },
      { timeout: 5000 },
    );
  }

  async function expectShutdown(code: number) {
    await vi.waitFor(() => expect(harness.exitCode, output).toBe(code), {
      timeout: 2000,
    });
    expect(output).toContain("All processes terminated");
    expect(output.match(/fixture-stopped:/g)).toHaveLength(
      code === 0 ? workerPaths.length : workerPaths.length - 1,
    );
  }

  it.each(["SIGINT", "SIGTERM"] as const)(
    "exits cleanly on %s while waiting for API readiness",
    async signal => {
      await startHarness(false);
      harness.kill(signal);
      await expectShutdown(0);
    },
  );

  it("waits for every worker when signalled again during shutdown", async () => {
    await startHarness(true);
    harness.kill("SIGTERM");
    await vi.waitFor(() => expect(output).toContain("fixture-stopped:"));
    harness.kill("SIGTERM");
    await expectShutdown(0);
  });

  it("keeps a failing worker's exit status while cleaning up its siblings", async () => {
    await startHarness(true);
    const worker = output.match(/fixture-ready:nuq-worker-0:(\d+)/);
    expect(worker).not.toBeNull();
    process.kill(Number(worker![1]), "SIGUSR1");
    await expectShutdown(1);
  });
});
