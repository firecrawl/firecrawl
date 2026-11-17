#!/usr/bin/env node

// Starts each compiled entry file of apps/api as its own process, the way a
// container command does (`node dist/src/index.js`), and checks that it comes
// up and exits cleanly on SIGTERM. The server tests start every process as
// `node dist/src/main.js <role>`, so this is the check that runs each entry
// file as the main module.
//
// Usage: node .github/scripts/start-entry-files.mjs <apps/api directory>
//
// It needs a built `dist` and the services the server tests run against. With
// NUQ_BACKEND=fdb it starts the FoundationDB worker alone, which is the one
// entry file that needs that backend.

import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const HEALTH_TIMEOUT_MS = 90_000;
// A process is stopped this long after its start at the earliest, so a file
// with no health path has loaded and registered its signal handlers by then.
const MIN_RUNNING_MS = 30_000;
const EXIT_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const OUTPUT_KEPT = 8_000;

// Ports of their own, so the check does not depend on which defaults are free.
const port = offset => String(3900 + offset);
const url = (offset, path) => `http://localhost:${port(offset)}${path}`;

const ROLE_FILES = [
  {
    file: "index.js",
    env: { PORT: port(0) },
    health: url(0, "/health/liveness"),
  },
  {
    file: "services/queue-worker.js",
    env: { WORKER_PORT: port(1) },
    health: url(1, "/liveness"),
  },
  {
    file: "services/extract-worker.js",
    env: { EXTRACT_WORKER_PORT: port(2) },
    health: url(2, "/liveness"),
  },
  {
    file: "services/worker/nuq-worker.js",
    env: { NUQ_WORKER_PORT: port(3) },
    health: url(3, "/health"),
  },
  {
    file: "services/worker/nuq-prefetch-worker.js",
    env: { NUQ_PREFETCH_WORKER_PORT: port(4) },
    health: url(4, "/health"),
  },
  {
    file: "services/worker/nuq-reconciler-worker.js",
    env: { NUQ_RECONCILER_WORKER_PORT: port(5) },
    health: url(5, "/health"),
  },
  {
    file: "services/cclog-worker.js",
    env: { CCLOG_WORKER_PORT: port(6) },
    health: url(6, "/health"),
  },
  // These two listen on no port. They pass when they are still running after
  // MIN_RUNNING_MS and then exit cleanly.
  { file: "services/indexing/index-worker.js" },
  { file: "services/zdr-worker.js" },
];

const FDB_WORKER_FILE = {
  file: "services/worker/nuq-fdb-worker.js",
  env: { NUQ_WORKER_PORT: port(3) },
  health: url(3, "/health"),
};

// The harness starts the API and the workers itself, so it runs after the
// files above have stopped.
const HARNESS_FILE = {
  file: "harness.js",
  args: ["--start-docker"],
  env: {
    PORT: port(0),
    WORKER_PORT: port(1),
    EXTRACT_WORKER_PORT: port(2),
    NUQ_WORKER_START_PORT: port(3),
  },
  health: url(0, "/health/liveness"),
};

const answers = healthUrl =>
  fetch(healthUrl, { signal: AbortSignal.timeout(2_000) }).then(
    async response => {
      await response.body?.cancel();
      return response.status === 200;
    },
    () => false,
  );

function start(apiDirectory, entry) {
  const child = spawn(
    process.execPath,
    [`dist/src/${entry.file}`, ...(entry.args ?? [])],
    {
      cwd: apiDirectory,
      env: { ...process.env, ...entry.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const run = { entry, child, startedAt: Date.now(), output: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", chunk => {
      run.output = (run.output + chunk).slice(-OUTPUT_KEPT);
    });
  }
  child.once("exit", (code, signal) => {
    run.result = code ?? signal;
  });
  // "close" follows "exit" once both streams have ended, so the output that
  // is printed for a failure includes what the process wrote last.
  run.closed = new Promise(resolve => {
    child.once("error", error => {
      run.result = error.message;
      resolve();
    });
    child.once("close", resolve);
  });
  return run;
}

async function waitUntilUp(run) {
  const { health } = run.entry;
  let answered = !health;
  while (run.result === undefined) {
    const elapsed = Date.now() - run.startedAt;
    answered ||= await answers(health);
    if (answered && elapsed >= MIN_RUNNING_MS) return;
    if (!answered && elapsed >= HEALTH_TIMEOUT_MS) {
      run.problem = `${health} did not answer with 200 in ${HEALTH_TIMEOUT_MS / 1000} seconds`;
      return;
    }
    await sleep(250);
  }
  run.problem = `exited with ${run.result} before it was stopped`;
}

async function stop(run) {
  if (run.result === undefined) {
    run.child.kill("SIGTERM");
    await Promise.race([run.closed, sleep(EXIT_TIMEOUT_MS)]);
    if (run.result === undefined) {
      run.problem ??= `still running ${EXIT_TIMEOUT_MS / 1000} seconds after SIGTERM`;
      run.child.kill("SIGKILL");
    } else if (run.result !== 0) {
      run.problem ??= `exited with ${run.result} on SIGTERM`;
    }
  }
  // Also for a process that exited by itself: its streams end shortly after.
  await Promise.race([run.closed, sleep(CLOSE_TIMEOUT_MS)]);
}

async function check(apiDirectory, entries) {
  const runs = entries.map(entry => start(apiDirectory, entry));
  await Promise.all(runs.map(waitUntilUp));
  await Promise.all(runs.map(stop));

  for (const run of runs) {
    const name = [`dist/src/${run.entry.file}`, ...(run.entry.args ?? [])].join(
      " ",
    );
    if (!run.problem) {
      console.log(`ok    node ${name}`);
      continue;
    }
    console.log(`FAIL  node ${name}: ${run.problem}`);
    console.log(run.output.replace(/^/gm, "      | "));
  }
  return runs.every(run => !run.problem);
}

const apiDirectory = process.argv[2];
if (!apiDirectory) {
  console.error("usage: start-entry-files.mjs <apps/api directory>");
  process.exit(2);
}

let ok;
if (process.env.NUQ_BACKEND === "fdb") {
  ok = await check(apiDirectory, [FDB_WORKER_FILE]);
} else {
  ok = await check(apiDirectory, ROLE_FILES);
  ok = (await check(apiDirectory, [HARNESS_FILE])) && ok;
}
process.exit(ok ? 0 : 1);
