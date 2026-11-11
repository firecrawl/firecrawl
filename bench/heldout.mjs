// Held-out check on pages the engine was never tuned on: a seeded sample of
// Firecrawl's public scrape dataset (Hugging Face
// firecrawl/scrape-content-dataset-v1, MIT), one URL per domain, written by
// bench/heldout-sample.mjs. A page passes when the engine's markdown contains
// the dataset's truth text; "clean" also requires that it leaves out the
// dataset's clutter text.
//   node bench/heldout.mjs --engine <name> --base-url <url> [--token t] [--concurrency 4]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { norm } from './lib/normalize.mjs';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const here = new URL('.', import.meta.url).pathname;
const tag = process.env.HELDOUT_SAMPLE || '';
const sample = JSON.parse(readFileSync(here + `.work/heldout/sample${tag}.json`, 'utf8'));
const conc = Number(args.concurrency || 4);
const headers = { 'content-type': 'application/json', ...(args.token ? { authorization: `Bearer ${args.token}` } : {}) };
// Share of a reference text's lines found in the output. A one-line reference
// is all or nothing; a long one passes when most of its lines are there, so
// one reflowed heading does not fail a page that has the whole article.
const lines = t => t.split(/\r?\n+/).map(norm).filter(p => p.length >= 20);
function share(text, reference) {
  const parts = lines(reference);
  if (!parts.length) { const whole = norm(reference); return whole && text.includes(whole) ? 1 : 0; }
  return parts.filter(p => text.includes(p)).length / parts.length;
}
const results = [];
let next = 0;
const started = Date.now();
async function worker() {
  while (next < sample.length) {
    const item = sample[next++];
    const t0 = Date.now();
    let md = '', ok = false, status = 0;
    try {
      const res = await fetch(args['base-url'] + '/v1/scrape', {
        method: 'POST', headers,
        body: JSON.stringify({ url: item.url, formats: ['markdown'], onlyMainContent: true }),
        signal: AbortSignal.timeout(60000),
      });
      status = res.status;
      const body = await res.json();
      ok = body.success === true;
      md = body?.data?.markdown || '';
    } catch { /* counted as a failed page */ }
    const text = norm(md);
    const truthShare = share(text, item.truth), lieShare = item.lie ? share(text, item.lie) : 0;
    results.push({ id: item.id, url: item.url, render_mode: item.render_mode, difficulty: item.difficulty, ms: Date.now() - t0, status, engine_ok: ok,
      truth: ok && truthShare >= 0.8, lie: ok && !!item.lie && lieShare >= 0.5, truth_share: +truthShare.toFixed(3), chars: md.length });
  }
}
await Promise.all(Array.from({ length: conc }, worker));
const wall = (Date.now() - started) / 1000;
const pass = results.filter(r => r.truth).length;
const clean = results.filter(r => r.truth && !r.lie).length;
const ms = results.map(r => r.ms).sort((a, b) => a - b);
const by = k => Object.fromEntries([...new Set(results.map(r => r[k]))].map(v => [v, `${results.filter(r => r[k] === v && r.truth).length}/${results.filter(r => r[k] === v).length}`]));
const summary = { engine: args.engine, n: results.length, truth_found: pass, truth_found_pct: +(100 * pass / results.length).toFixed(1), truth_and_no_lie: clean,
  lie_found: results.filter(r => r.lie).length, p50_ms: ms[Math.floor(ms.length / 2)], p95_ms: ms[Math.floor(ms.length * 0.95)], wall_s: +wall.toFixed(1),
  pages_per_s: +(results.length / wall).toFixed(2), by_render_mode: by('render_mode'), by_difficulty: by('difficulty') };
mkdirSync(here + 'results', { recursive: true });
writeFileSync(here + `results/${args.engine}.heldout${tag}.json`, JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary));
