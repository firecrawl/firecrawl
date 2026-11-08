import { createHash } from "node:crypto";
import pLimit from "p-limit";
import type { Config } from "../config.js";
import { createEnginePool, type EngineName } from "../engines/index.js";
import { getFormat } from "../formats/index.js";
import type { InputSource } from "../inputs/types.js";
import { pickOutput } from "../outputs/index.js";
import { makeProgress } from "../progress.js";
import { loadState, saveState, type State } from "../state.js";
import { buildRequest, resolveEngine } from "./scrape.js";

export interface BatchCmdOptions {
  input: InputSource;
  inputKey: string;
  config: Config;
  profileName: string;
  formatName: string;
  out: string | undefined;
  concurrency: number;
  resume: boolean;
  progress: boolean;
  engineOverride: EngineName | undefined;
  cdpUrlOverride: string | undefined;
}

export async function runBatch(opts: BatchCmdOptions): Promise<void> {
  const fmt = getFormat(opts.formatName);
  const pool = createEnginePool(opts.config, opts.cdpUrlOverride);
  const writer = await pickOutput(opts.out);
  await writer.open();

  const stateKey = createHash("sha1")
    .update(`${opts.inputKey}|${opts.profileName}|${opts.formatName}`)
    .digest("hex");
  const state: State = opts.resume
    ? await loadState(stateKey)
    : { completed: new Set(), failed: new Map() };

  const urls: string[] = [];
  for await (const u of opts.input.read()) {
    if (opts.resume && state.completed.has(u)) continue;
    urls.push(u);
  }

  if (opts.resume) {
    process.stderr.write(`${state.completed.size} already done, ${urls.length} to do\n`);
  }

  const progress = makeProgress({
    enabled: opts.progress,
    outputIsStdout: writer.isStdout,
  });
  progress.start(urls.length);

  const limit = pLimit(opts.concurrency);
  let okCount = 0;
  let failCount = 0;

  const tasks = urls.map((url) =>
    limit(async () => {
      try {
        const engineName = resolveEngine(url, opts.config, opts.profileName, opts.engineOverride);
        const engine = pool.get(engineName);
        const req = buildRequest(url, opts.config, opts.profileName, fmt.apiFormats);
        const data = await engine.scrape(req);
        const content = fmt.fromResponse(data);
        await writer.write(url, content, fmt.ext);
        state.completed.add(url);
        state.failed.delete(url);
        okCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state.failed.set(url, msg);
        failCount++;
        process.stderr.write(`FAIL ${url}: ${msg}\n`);
      } finally {
        progress.tick(url);
      }
    }),
  );

  try {
    await Promise.all(tasks);
  } finally {
    progress.stop();
    await writer.close();
    await pool.closeAll();
    await saveState(stateKey, state);
  }

  process.stderr.write(`done: ${okCount} ok, ${failCount} failed\n`);
  if (failCount > 0 && !opts.resume) {
    process.stderr.write(`(rerun with --resume to retry failures)\n`);
  }
}
