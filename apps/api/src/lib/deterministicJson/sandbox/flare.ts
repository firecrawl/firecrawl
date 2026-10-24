import { randomUUID } from "node:crypto";
import { config } from "../../../config";
import { SANDBOX_TIMEOUT_MS } from "../config";
import type { SandboxRunner } from "./runExtractor";

const SNAPSHOT = "deterministic-json";

// Runs inside the sandbox: executes job.json's code as the body of
// `async (input, host, require) => { ... }` and speaks JSON lines with the
// worker, frames on stdout and host results on stdin.
const GUEST_RUNNER = String.raw`
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/opt/");
const send = frame => new Promise(resolve => process.stdout.write(JSON.stringify(frame) + "\n", resolve));
const toStderr = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
console.log = console.info = console.debug = console.warn = console.error = toStderr;

let nextId = 1;
const pending = new Map();
const host = (channel, payload) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ t: "host", id, channel, payload });
  });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.value);
  }
});

const { code, input } = JSON.parse(readFileSync("/work/job.json", "utf8"));
const AsyncFunction = (async () => {}).constructor;
try {
  const value = await new AsyncFunction("input", "host", "require", code)(input, host, require);
  await send({ t: "result", value: JSON.parse(JSON.stringify(value ?? null)) });
} catch (err) {
  await send({ t: "error", message: err instanceof Error ? err.message : String(err) });
}
process.exit(0);
`;

type Init = {
  method?: string;
  json?: unknown;
  body?: string;
  query?: string;
  headers?: Record<string, string>;
};

async function call(
  url: string,
  token: string,
  init: Init,
  signal: AbortSignal,
): Promise<Response> {
  const method = init.method ?? "GET";
  const res = await fetch(url + (init.query ?? ""), {
    method,
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.json !== undefined && { "content-type": "application/json" }),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `sandbox ${method} ${new URL(url).pathname} failed: ${res.status} ${detail}`,
    );
  }
  return res;
}

async function* stdoutLines(
  res: Response,
): AsyncGenerator<{ line?: string; exit?: number | null; stderr?: string }> {
  const decoder = new TextDecoder();
  const out = new TextDecoder();
  let sse = "";
  let partial = "";
  let stderr = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    sse += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    let end: number;
    while ((end = sse.indexOf("\n\n")) >= 0) {
      const data = sse
        .slice(0, end)
        .split("\n")
        .filter(l => l.startsWith("data:"))
        .map(l => l.slice(5).trimStart())
        .join("\n");
      sse = sse.slice(end + 2);
      if (!data) continue;
      const ev = JSON.parse(data) as {
        stream: "stdout" | "stderr" | "exit";
        data?: string;
        exit_code?: number | null;
      };
      if (ev.stream === "exit") {
        yield { exit: ev.exit_code ?? null, stderr };
        return;
      }
      const bytes = Buffer.from(ev.data ?? "", "base64");
      if (ev.stream === "stderr") {
        stderr = (stderr + bytes.toString("utf8")).slice(-2000);
        continue;
      }
      const parts = (partial + out.decode(bytes, { stream: true })).split("\n");
      partial = parts.pop()!;
      for (const line of parts) if (line) yield { line };
    }
  }
}

/** Runs each job in a fresh VM forked from the deterministic-json snapshot, with no network egress. */
export function flareSandboxRunner(): SandboxRunner | undefined {
  const apiKey = config.FLARE_API_KEY;
  if (!apiKey) return undefined;
  const api = config.FLARE_API_URL.replace(/\/+$/, "");

  return async job => {
    const timeout = AbortSignal.timeout(SANDBOX_TIMEOUT_MS);
    const failed = new AbortController();
    const signal = AbortSignal.any([timeout, failed.signal]);
    try {
      const sb = (await (
        await call(
          `${api}/v1/sandboxes`,
          apiKey,
          {
            method: "POST",
            query: "?wait=30",
            headers: { "idempotency-key": randomUUID() },
            json: {
              snapshot: SNAPSHOT,
              network: { egress: "none" },
              timeout_s: Math.ceil(SANDBOX_TIMEOUT_MS / 1000) + 30,
              labels: { app: "firecrawl-api", module: "deterministic-json" },
            },
          },
          signal,
        )
      ).json()) as {
        id: string;
        status: string;
        data_url: string;
        token: string;
      };

      try {
        if (sb.status !== "running")
          throw new Error(`sandbox ${sb.id} is ${sb.status}`);
        const node = `${sb.data_url.replace(/\/+$/, "")}/v1/sandboxes/${sb.id}`;
        const put = (path: string, body: string) =>
          call(
            `${node}/files`,
            sb.token,
            { method: "PUT", query: `?path=${path}&mode=0644`, body },
            signal,
          );
        await put("/work/runner.mjs", GUEST_RUNNER);
        await put(
          "/work/job.json",
          JSON.stringify({ code: job.code, input: job.input }),
        );
        const proc = (await (
          await call(
            `${node}/processes`,
            sb.token,
            {
              method: "POST",
              json: {
                cmd: ["node", "/work/runner.mjs"],
                cwd: "/work",
                user: "node",
              },
            },
            signal,
          )
        ).json()) as { id: string };
        const procUrl = `${node}/processes/${proc.id}`;
        const output = await call(
          `${procUrl}/output`,
          sb.token,
          { query: "?since=0&follow=true" },
          signal,
        );

        for await (const ev of stdoutLines(output)) {
          if (ev.exit !== undefined)
            throw new Error(
              `sandbox process exited (${ev.exit}) without a result: ${ev.stderr}`,
            );
          let frame: any;
          try {
            frame = JSON.parse(ev.line!);
          } catch {
            continue;
          }
          if (frame.t === "result") return frame.value;
          if (frame.t === "error") throw new Error(frame.message);
          if (frame.t !== "host") continue;
          void (async () => {
            let value: unknown;
            let error: string | undefined;
            try {
              value = await job.onHost(frame.channel, frame.payload);
            } catch (err) {
              error = err instanceof Error ? err.message : String(err);
            }
            await call(
              `${procUrl}/stdin`,
              sb.token,
              {
                method: "POST",
                body: JSON.stringify({ id: frame.id, value, error }) + "\n",
              },
              signal,
            ).catch(err => failed.abort(err));
          })();
        }
        throw new Error("sandbox output ended without a result");
      } finally {
        await fetch(`${api}/v1/sandboxes/${sb.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});
      }
    } catch (err) {
      if (failed.signal.aborted) throw failed.signal.reason;
      if (timeout.aborted)
        throw new Error(`sandbox timed out after ${SANDBOX_TIMEOUT_MS}ms`);
      throw err;
    }
  };
}
