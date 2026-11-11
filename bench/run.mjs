#!/usr/bin/env node
// Benchmark runner. Speaks only HTTP to an engine that is already running.
//
//   node bench/run.mjs --engine <name> --base-url <url> --corpus static|live
//        [--concurrency 8] [--repeat 3] [--suite] [--pid <pid> | --rss-cmd "<cmd printing KB>"]
//        [--out results/<name>.<corpus>.json] [--token <bearer>]
//        [--static-base http://127.0.0.1:3900] [--limit n] [--timeout-ms 60000] [--seed 42]
//        [--settle-s 10] [--no-warmup | --warmup] [--no-cache-bust] [--no-serve] [--body-extra '{"k":"v"}']
//
// POST {base-url}/v1/scrape {"url","formats":["markdown"],"onlyMainContent":true}
// One warm-up pass (static corpus only, unless --warmup), then --repeat measured passes per concurrency level. URL order is shuffled
// with a fixed seed. --suite runs concurrency 1, 8 and 32 with 3 repeats each and reports medians.
// Markdown from the first measured pass is saved to bench/.work/out/<engine>/<id>.md.
import { spawn, execFile, exec } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const engine = opt('engine');
const baseUrl = (opt('base-url') || '').replace(/\/+$/, '');
const corpus = opt('corpus', 'static');
if (!engine || !baseUrl || !['static', 'live'].includes(corpus)) {
  console.error('usage: node bench/run.mjs --engine <name> --base-url <url> --corpus static|live [--suite] [--concurrency n] [--repeat n] [--pid pid]');
  process.exit(2);
}
const suite = flag('suite');
const levels = suite ? [1, 8, 32] : [Number(opt('concurrency', corpus === 'live' ? 4 : 8))];
const repeat = suite ? Number(opt('repeat', 3)) : Number(opt('repeat', corpus === 'live' ? 1 : 3));
const timeoutMs = Number(opt('timeout-ms', 60000));
const seed = Number(opt('seed', 42));
const settleS = Number(opt('settle-s', 10));
const token = opt('token');
const pid = opt('pid') ? Number(opt('pid')) : null;
const rssCmd = opt('rss-cmd');
const staticBase = opt('static-base', 'http://127.0.0.1:3900').replace(/\/+$/, '');
const limit = opt('limit') ? Number(opt('limit')) : null;
const cacheBust = corpus === 'static' && !flag('no-cache-bust');
// the live corpus gets no warm-up pass by default: it would hit every public site twice
const warmup = corpus === 'live' ? flag('warmup') : !flag('no-warmup');
const bodyExtra = opt('body-extra') ? JSON.parse(opt('body-extra')) : {};
const outPath = resolve(opt('out', join(HERE, 'results', `${engine}.${corpus}.json`)));
const outDir = join(HERE, '.work', 'out', engine);

// ---- corpus ------------------------------------------------------------------------------
let pages;
if (corpus === 'static') {
  const manifest = JSON.parse(readFileSync(join(HERE, 'corpus', 'manifest.json'), 'utf8'));
  pages = manifest.map((m) => ({ id: m.id, url: `${staticBase}/p/${m.id}.html`, category: m.category }));
} else {
  const live = JSON.parse(readFileSync(join(HERE, 'corpus', 'live.json'), 'utf8'));
  pages = live.urls.map((m) => ({ id: m.id, url: m.url, category: m.category, js: !!m.js, hard: !!m.hard }));
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, s) {
  const rnd = mulberry32(s);
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
if (limit) pages = shuffled(pages, seed).slice(0, limit).sort((a, b) => a.id.localeCompare(b.id));

// ---- static server (started here if nothing is listening) ---------------------------------
let serverChild = null;
async function ensureStaticServer() {
  const u = new URL(staticBase);
  const check = `http://127.0.0.1:${u.port || 80}/healthz`;
  const up = async () => {
    try { return (await fetch(check, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  };
  if (await up()) return;
  if (flag('no-serve')) throw new Error(`static corpus server not reachable at ${check}; run: node bench/serve.mjs`);
  const bind = ['127.0.0.1', 'localhost'].includes(u.hostname) ? '127.0.0.1' : '0.0.0.0';
  serverChild = spawn(process.execPath, [join(HERE, 'serve.mjs'), '--port', String(u.port || 80), '--host', bind], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { if (await up()) return; await sleep(200); }
  throw new Error('static corpus server did not start');
}
function cleanup() { if (serverChild) { serverChild.kill('SIGTERM'); serverChild = null; } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---- RSS sampling --------------------------------------------------------------------------
function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { maxBuffer: 16 << 20 }, (err, stdout) => res(err ? '' : stdout)));
}
async function sampleRssKb() {
  if (rssCmd) {
    const out = await new Promise((res) => exec(rssCmd, { timeout: 5000 }, (err, stdout) => res(err ? '' : stdout)));
    const m = /-?\d+(\.\d+)?/.exec(out);
    return m ? Math.round(Number(m[0])) : null;
  }
  if (!pid) return null;
  const out = await run('ps', ['-axo', 'pid=,ppid=,rss=']);
  const kids = new Map();
  const rss = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const [p, pp, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rss.set(p, r);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  if (!rss.has(pid)) return null;
  let sum = 0;
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    sum += rss.get(p) || 0;
    for (const k of kids.get(p) || []) stack.push(k);
  }
  return sum;
}
class RssSampler {
  constructor() { this.peak = null; this.n = 0; this.timer = null; this.busy = false; }
  start() {
    if (!pid && !rssCmd) return;
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      const v = await sampleRssKb();
      this.busy = false;
      if (v != null) { this.n++; if (this.peak == null || v > this.peak) this.peak = v; }
    }, 250);
  }
  async mark() {
    // one more sample so that passes shorter than the 250 ms interval still report a peak
    if (pid || rssCmd) { const v = await sampleRssKb(); if (v != null && (this.peak == null || v > this.peak)) this.peak = v; }
    const p = this.peak; this.peak = null; return p;
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}
const median = (xs) => {
  const a = xs.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ---- one request ---------------------------------------------------------------------------
async function scrape(page, tag) {
  const url = cacheBust ? `${page.url}?r=${tag}` : page.url;
  const t0 = performance.now();
  const rec = { id: page.id, ms: 0, status: 0, ok: false, md_len: 0 };
  let markdown = null;
  try {
    const res = await fetch(`${baseUrl}/v1/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, ...bodyExtra }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    rec.status = res.status;
    const text = await res.text();
    rec.ms = performance.now() - t0;
    let json = null;
    try { json = JSON.parse(text); } catch { rec.err = 'bad-json'; }
    if (json) {
      markdown = typeof json?.data?.markdown === 'string' ? json.data.markdown : null;
      rec.ok = res.status === 200 && json.success === true && markdown != null;
      rec.md_len = markdown ? markdown.length : 0;
      if (!rec.ok) rec.err = String(json.error || json.code || (markdown == null ? 'no-markdown' : 'http-' + res.status)).slice(0, 160);
      const sc = json?.data?.metadata?.statusCode;
      if (typeof sc === 'number') rec.page_status = sc;
      // which internal path produced the page, when the engine says (e.g. fetch vs browser)
      const via = json?.data?.metadata?.engine ?? json?.data?.metadata?.scrapeMethod;
      if (typeof via === 'string') rec.via = via.slice(0, 40);
    }
  } catch (e) {
    rec.ms = performance.now() - t0;
    rec.err = e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.message || e).slice(0, 160);
  }
  rec.ms = r1(rec.ms);
  return { rec, markdown };
}

async function pass(list, concurrency, tag, onResult) {
  let next = 0;
  const t0 = performance.now();
  const recs = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (next < list.length) {
      const page = list[next++];
      const { rec, markdown } = await scrape(page, tag);
      recs.push(rec);
      if (onResult) onResult(page, rec, markdown);
    }
  }));
  const wall = performance.now() - t0;
  const okLat = recs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const ok = okLat.length;
  return {
    recs,
    stats: {
      wall_ms: Math.round(wall), requests: recs.length, ok, errors: recs.length - ok,
      pages_per_s: r1(ok / (wall / 1000)),
      p50_ms: pct(okLat, 50), p95_ms: pct(okLat, 95), p99_ms: pct(okLat, 99),
      mean_ms: ok ? r1(okLat.reduce((a, b) => a + b, 0) / ok) : null,
    },
  };
}

// ---- main ----------------------------------------------------------------------------------
if (corpus === 'static') await ensureStaticServer();
mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(outPath), { recursive: true });
for (const p of pages) rmSync(join(outDir, p.id + '.md'), { force: true });

const result = {
  kind: 'run', engine, corpus, base_url: baseUrl, started_at: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model, mem_gb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
  config: { levels, repeat, timeout_ms: timeoutMs, seed, warmup, cache_bust: cacheBust, static_base: corpus === 'static' ? staticBase : undefined, pages: pages.length, body_extra: bodyExtra },
  rss: { mode: rssCmd ? 'cmd' : pid ? 'pid-tree' : 'none', idle_kb: null, peak_kb: null },
  levels: [], pages: {}, requests: [],
};

const sampler = new RssSampler();
if (pid || rssCmd) {
  process.stderr.write(`settling ${settleS}s for idle RSS...\n`);
  await sleep(settleS * 1000);
  const idle = [];
  for (let i = 0; i < 8; i++) { idle.push(await sampleRssKb()); await sleep(250); }
  result.rss.idle_kb = median(idle);
  if (result.rss.idle_kb == null) process.stderr.write('warning: RSS sampler returned nothing (wrong --pid / --rss-cmd?)\n');
  sampler.start();
}

let saved = false;
let overallPeak = null;
for (let li = 0; li < levels.length; li++) {
  const c = levels[li];
  if (li === 0 && warmup) {
    const w = await pass(shuffled(pages, seed - 1), c, 'w', null);
    process.stderr.write(`[${engine}] warm-up c=${c}: ${w.stats.ok}/${w.stats.requests} ok in ${w.stats.wall_ms} ms\n`);
    const p = await sampler.mark();
    if (p != null && (overallPeak == null || p > overallPeak)) overallPeak = p;
  }
  const level = { concurrency: c, passes: [] };
  for (let r = 0; r < repeat; r++) {
    const save = !saved;
    const { recs, stats } = await pass(shuffled(pages, seed + li * 1000 + r), c, `${c}-${r}`, (page, rec, markdown) => {
      if (!save) return;
      result.pages[page.id] = { url: page.url, category: page.category, ok: rec.ok, status: rec.status, ms: rec.ms, md_len: rec.md_len, err: rec.err, page_status: rec.page_status, via: rec.via, js: page.js, hard: page.hard };
      if (rec.ok && markdown != null) writeFileSync(join(outDir, page.id + '.md'), markdown);
    });
    saved = true;
    stats.peak_rss_kb = await sampler.mark();
    if (stats.peak_rss_kb != null && (overallPeak == null || stats.peak_rss_kb > overallPeak)) overallPeak = stats.peak_rss_kb;
    level.passes.push(stats);
    for (const rec of recs) result.requests.push({ c, pass: r, ...rec });
    process.stderr.write(`[${engine}] c=${c} pass ${r + 1}/${repeat}: ${stats.pages_per_s} pages/s, p50 ${stats.p50_ms} ms, p95 ${stats.p95_ms} ms, errors ${stats.errors}/${stats.requests}` + (stats.peak_rss_kb != null ? `, peak RSS ${Math.round(stats.peak_rss_kb / 1024)} MB` : '') + '\n');
  }
  const P = level.passes;
  level.median = {
    pages_per_s: median(P.map((p) => p.pages_per_s)), wall_ms: median(P.map((p) => p.wall_ms)),
    p50_ms: median(P.map((p) => p.p50_ms)), p95_ms: median(P.map((p) => p.p95_ms)), p99_ms: median(P.map((p) => p.p99_ms)),
    mean_ms: median(P.map((p) => p.mean_ms)),
    error_rate: r1(1000 * P.reduce((a, p) => a + p.errors, 0) / Math.max(1, P.reduce((a, p) => a + p.requests, 0))) / 1000,
    peak_rss_kb: P.some((p) => p.peak_rss_kb != null) ? Math.max(...P.map((p) => p.peak_rss_kb || 0)) : null,
  };
  result.levels.push(level);
}
sampler.stop();
result.rss.peak_kb = overallPeak;
if (pid || rssCmd) {
  // what the engine still holds 3 s after the last request
  await sleep(3000);
  result.rss.after_kb = await sampleRssKb();
}
const viaCount = {};
for (const p of Object.values(result.pages)) if (p.via) viaCount[p.via] = (viaCount[p.via] || 0) + 1;
if (Object.keys(viaCount).length) result.via = viaCount;
result.finished_at = new Date().toISOString();
writeFileSync(outPath, JSON.stringify(result, null, 1) + '\n');
cleanup();

const mb = (kb) => (kb == null ? 'n/a' : Math.round(kb / 1024) + ' MB');
console.log(`\n${engine} / ${corpus} (${pages.length} pages)`);
for (const l of result.levels) console.log(`  c=${String(l.concurrency).padEnd(3)} ${l.median.pages_per_s} pages/s  p50 ${l.median.p50_ms} ms  p95 ${l.median.p95_ms} ms  p99 ${l.median.p99_ms} ms  errors ${(l.median.error_rate * 100).toFixed(1)}%`);
console.log(`  RSS idle ${mb(result.rss.idle_kb)}  peak ${mb(result.rss.peak_kb)}  3 s after load ${mb(result.rss.after_kb)}`);
if (result.via) console.log('  path reported by engine: ' + Object.entries(result.via).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`  results: ${outPath}\n  outputs: ${outDir}`);
process.exit(0);
