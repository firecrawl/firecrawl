#!/usr/bin/env node
// Merge bench/results/*.json (runs + scores) into bench/results/REPORT.md.
//
//   node bench/report.mjs            # scores every engine with saved outputs first, then writes the report
//   node bench/report.mjs --no-score # only merge what is already in results/
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
if (!process.argv.includes('--no-score')) {
  try { execFileSync(process.execPath, [join(HERE, 'score.mjs'), '--all'], { stdio: 'inherit' }); } catch { /* nothing to score yet */ }
}

const runs = {}, scores = {};
for (const f of existsSync(RESULTS) ? readdirSync(RESULTS) : []) {
  if (!f.endsWith('.json')) continue;
  let j;
  try { j = JSON.parse(readFileSync(join(RESULTS, f), 'utf8')); } catch { continue; }
  if (j.kind === 'run') (runs[j.corpus] ||= {})[j.engine] = j;
  if (j.kind === 'score') (scores[j.corpus] ||= {})[j.engine] = j;
}

const pctS = (x, d = 1) => (x == null ? '–' : (x * 100).toFixed(d) + '%');
const num = (x, d = 0) => (x == null ? '–' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const f3 = (x) => (x == null ? '–' : x.toFixed(3));
const mb = (kb) => (kb == null ? '–' : num(kb / 1024) + ' MB');
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '| ' + head.map((h, i) => (i ? '---:' : '---')).join(' | ') + ' |', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n');
const level = (run, c) => run?.levels?.find((l) => l.concurrency === c)?.median;

const out = [];
out.push('# Scraper benchmark report', '');
out.push(`Generated ${new Date().toISOString()} by \`node bench/report.mjs\`. Definitions and caveats: [bench/README.md](../README.md).`, '');

// ---- static ---------------------------------------------------------------------------------
{
  const engines = [...new Set([...Object.keys(runs.static || {}), ...Object.keys(scores.static || {})])].sort();
  if (engines.length) {
    const any = runs.static?.[engines.find((e) => runs.static?.[e])];
    out.push('## Static corpus (localhost snapshots)', '');
    if (any) out.push(`${any.config.pages} pages, ${any.config.repeat} measured passes per concurrency level after one warm-up pass, medians of passes. Host: ${any.host.cpu_model}, ${any.host.cpus} cores, ${any.host.mem_gb} GB, ${any.host.platform}/${any.host.arch}.`, '');
    out.push(table(
      ['engine', 'pages/s c=1', 'pages/s c=8', 'pages/s c=32', 'p50 ms', 'p95 ms', 'idle RSS', 'peak RSS', 'RSS after', 'errors', 'recall', 'noise', 'structure', 'perfect', 'failures', 'median tokens'],
      engines.map((e) => {
        const r = runs.static?.[e], s = scores.static?.[e]?.overall;
        const base = r?.levels?.[0]?.median;
        const reqs = r ? r.levels.reduce((a, l) => a + l.passes.reduce((x, p) => x + p.requests, 0), 0) : 0;
        const errs = r ? r.levels.reduce((a, l) => a + l.passes.reduce((x, p) => x + p.errors, 0), 0) : 0;
        return [e, num(level(r, 1)?.pages_per_s, 1), num(level(r, 8)?.pages_per_s, 1), num(level(r, 32)?.pages_per_s, 1),
          num(base?.p50_ms, 1), num(base?.p95_ms, 1), mb(r?.rss?.idle_kb), mb(r?.rss?.peak_kb), mb(r?.rss?.after_kb), r ? pctS(errs / Math.max(1, reqs), 2) : '–',
          f3(s?.recall_mean), f3(s?.noise_mean), f3(s?.structure_mean), pctS(s?.perfect_share), pctS(s?.failure_share), num(s?.tokens_median)];
      })), '');
    out.push('p50/p95 are per-request latency at the lowest concurrency level run (c=1 in a suite), successful requests only. RSS is summed over the engine process and its descendants: idle before any request, peak during load, and 3 s after the last request. recall, noise and structure are means over pages; perfect = recall 1 and noise 0; failures = recall < 0.5 (a page with no output counts as recall 0).', '');

    const lv = [...new Set(engines.flatMap((e) => (runs.static?.[e]?.levels || []).map((l) => l.concurrency)))].sort((a, b) => a - b);
    if (lv.length) {
      out.push('### Latency by concurrency', '');
      out.push(table(['engine', ...lv.flatMap((c) => [`c=${c} p50`, `c=${c} p95`, `c=${c} p99`])],
        engines.filter((e) => runs.static?.[e]).map((e) => [e, ...lv.flatMap((c) => { const m = level(runs.static[e], c); return [num(m?.p50_ms, 1), num(m?.p95_ms, 1), num(m?.p99_ms, 1)]; })])), '');
    }

    const cats = [...new Set(engines.flatMap((e) => Object.keys(scores.static?.[e]?.by_category || {})))];
    const scored = engines.filter((e) => scores.static?.[e]);
    if (cats.length) {
      const n = scores.static[scored[0]].by_category;
      out.push('### Quality by category', '', 'Pages per category: ' + cats.map((c) => `${c} ${n[c]?.pages ?? 0}`).join(', ') + '.', '');
      for (const [title, key, fmt] of [['Recall (mean)', 'recall_mean', f3], ['Noise (mean, lower is better)', 'noise_mean', f3], ['Structure (mean)', 'structure_mean', f3], ['Perfect pages', 'perfect_share', pctS], ['Failures (recall < 0.5)', 'failure_share', pctS], ['Median output tokens', 'tokens_median', num]]) {
        out.push(`**${title}**`, '');
        out.push(table(['engine', ...cats], scored.map((e) => [e, ...cats.map((c) => fmt(scores.static[e].by_category[c]?.[key]))])), '');
      }
    }
  }
}

// ---- live -----------------------------------------------------------------------------------
{
  const engines = [...new Set([...Object.keys(runs.live || {}), ...Object.keys(scores.live || {})])].sort();
  if (engines.length) {
    out.push('## Live corpus (public web)', '');
    out.push('"content ok" means the page\'s verified snippets are in the markdown (2 of 3), not just HTTP 200. Pages tagged `hard` (commonly block bots) are reported in their own columns and are not part of the other rates.', '');
    out.push(table(
      ['engine', 'pages', 'content ok', 'static HTML ok', 'JS ok', 'answered but wrong/empty', 'errors', 'hard ok', 'p50 ms', 'p95 ms', 'pages/s', 'median tokens'],
      engines.map((e) => {
        const r = runs.live?.[e], s = scores.live?.[e];
        const m = r?.levels?.[0]?.median;
        const frac = (a) => (a ? `${a.content_ok}/${a.pages} (${pctS(a.content_ok_share, 0)})` : '–');
        return [e, num(s?.overall?.pages), frac(s?.overall), frac(s?.static_html), frac(s?.js), pctS(s?.overall?.empty_or_wrong_share), pctS(s?.overall?.error_share), frac(s?.hard),
          num(m?.p50_ms), num(m?.p95_ms), num(m?.pages_per_s, 1), num(s?.overall?.tokens_median)];
      })), '');
    const cats = [...new Set(engines.flatMap((e) => Object.keys(scores.live?.[e]?.by_category || {})))];
    const scored = engines.filter((e) => scores.live?.[e]);
    if (cats.length) {
      out.push('**Content ok by category (hard pages excluded)**', '');
      out.push(table(['engine', ...cats], scored.map((e) => [e, ...cats.map((c) => { const a = scores.live[e].by_category[c]; return a ? `${a.content_ok}/${a.pages}` : '–'; })])), '');
    }
  }
}

if (out.length <= 3) out.push('No results yet. Run `node bench/run.mjs ...` first.');
writeFileSync(join(RESULTS, 'REPORT.md'), out.join('\n') + '\n');
console.log('wrote ' + join(RESULTS, 'REPORT.md'));
