#!/usr/bin/env node
// Score an engine's saved markdown against ground truth.
//
//   node bench/score.mjs --engine <name> [--corpus static|live]   # one engine
//   node bench/score.mjs --all                                    # every engine with saved outputs
//   node bench/score.mjs --selfcheck                              # verify truth + normaliser against source text
//   node bench/score.mjs --engine <name> --worst 10               # print the lowest-scoring pages
//
// Per page: recall (share of must_contain found), noise (share of must_not_contain found),
// structure (headings, table rows, code blocks, list items in the markdown vs the source's main
// content, each capped at 1, averaged over the kinds the source has), chars, tokens (chars/4),
// perfect (recall 1 and noise 0), failure (recall < 0.5). Missing output = recall 0.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from './lib/normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OUT = join(HERE, '.work', 'out');
const RESULTS = join(HERE, 'results');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const mean = (xs) => { const a = xs.filter((x) => x != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const median = (xs) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// ---- markdown structure ---------------------------------------------------------------------
export function mdStructure(md) {
  const lines = md.split(/\r?\n/);
  let headings = 0, tableRows = 0, code = 0, items = 0, links = 0;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence == null) { fence = f[1][0]; code++; } else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence != null) continue;
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) headings++;
    else if (/^\s{0,3}(=+|-{2,})\s*$/.test(line) && i > 0 && /\S/.test(lines[i - 1]) && !/^\s*[|>#-]/.test(lines[i - 1]) && !/^\s*$/.test(lines[i - 1]) && (i < 2 || /^\s*$/.test(lines[i - 2]))) headings++;
    const t = line.trim();
    if (t.startsWith('|') && t.indexOf('|', 1) > 0 && !/^\|?[\s:|-]+\|?$/.test(t)) tableRows++;
    if (/^\s*(?:[-*+]|\d{1,4}[.)])\s+\S/.test(line) && !/^\s*(?:[-*_]\s*){3,}$/.test(line)) items++;
  }
  // raw HTML that some converters leave in place
  tableRows += (md.match(/<tr[\s>]/gi) || []).length;
  code += (md.match(/<pre[\s>]/gi) || []).length;
  items += (md.match(/<li[\s>]/gi) || []).length;
  headings += (md.match(/<h[1-6][\s>]/gi) || []).length;
  links = (md.match(/\]\([^)\s]+/g) || []).length;
  return { headings, table_rows: tableRows, code_blocks: code, list_items: items, links };
}

function structureScore(truth, got) {
  const want = {
    headings: truth.headings,
    table_rows: (truth.table_rows || []).reduce((a, b) => a + b, 0),
    code_blocks: truth.code_blocks,
    list_items: truth.list_items,
  };
  const parts = {};
  for (const k of Object.keys(want)) if (want[k] > 0) parts[k] = Math.min(1, got[k] / want[k]);
  const vals = Object.values(parts);
  return { score: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, parts, want };
}

function aggregate(rows) {
  return {
    pages: rows.length,
    answered: rows.filter((r) => r.has_output).length,
    recall_mean: r3(mean(rows.map((r) => r.recall))),
    recall_median: r3(median(rows.map((r) => r.recall))),
    noise_mean: r3(mean(rows.map((r) => r.noise))),
    structure_mean: r3(mean(rows.map((r) => r.structure))),
    perfect_share: r3(rows.filter((r) => r.perfect).length / Math.max(1, rows.length)),
    failure_share: r3(rows.filter((r) => r.failure).length / Math.max(1, rows.length)),
    tokens_median: median(rows.filter((r) => r.has_output).map((r) => r.tokens)),
    tokens_mean: Math.round(mean(rows.filter((r) => r.has_output).map((r) => r.tokens)) || 0),
  };
}

function scoreStatic(engine) {
  const manifest = readJson(join(HERE, 'corpus', 'manifest.json'));
  const rows = [];
  for (const m of manifest) {
    const truth = readJson(join(HERE, 'corpus', 'truth', m.id + '.json'));
    const p = join(OUT, engine, m.id + '.md');
    const has = existsSync(p);
    const md = has ? readFileSync(p, 'utf8') : '';
    const n = norm(md);
    const missing = truth.must_contain.filter((s) => !n.includes(norm(s.text)));
    const noisy = truth.must_not_contain.filter((s) => n.includes(norm(s.text)));
    const recall = truth.must_contain.length ? 1 - missing.length / truth.must_contain.length : null;
    const noise = truth.must_not_contain.length ? noisy.length / truth.must_not_contain.length : null;
    const got = mdStructure(md);
    const st = structureScore(truth.structure, got);
    rows.push({
      id: m.id, category: m.category, url: m.url, has_output: has,
      recall: r3(recall), noise: r3(noise), structure: r3(st.score), structure_parts: st.parts,
      chars: md.length, tokens: Math.round(md.length / 4),
      perfect: recall === 1 && !noisy.length, failure: recall != null && recall < 0.5,
      missing: missing.map((s) => ({ kind: s.kind, text: s.text })), noise_found: noisy.map((s) => ({ kind: s.kind, text: s.text })),
      md_structure: got, truth_structure: st.want,
    });
  }
  const by = {};
  for (const r of rows) (by[r.category] ||= []).push(r);
  return {
    kind: 'score', engine, corpus: 'static', scored_at: new Date().toISOString(),
    overall: aggregate(rows),
    by_category: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, aggregate(v)])),
    pages: rows,
  };
}

function scoreLive(engine) {
  const live = readJson(join(HERE, 'corpus', 'live.json'));
  const runPath = join(RESULTS, `${engine}.live.json`);
  const run = existsSync(runPath) ? readJson(runPath) : null;
  const rows = [];
  for (const u of live.urls) {
    const p = join(OUT, engine, u.id + '.md');
    const has = existsSync(p);
    const md = has ? readFileSync(p, 'utf8') : '';
    const n = norm(md);
    const found = u.must_contain.filter((s) => n.includes(norm(s)));
    const need = Math.max(1, Math.ceil((2 * u.must_contain.length) / 3));
    const rp = run?.pages?.[u.id];
    rows.push({
      id: u.id, url: u.url, category: u.category, js: !!u.js, hard: !!u.hard, has_output: has,
      engine_ok: rp ? rp.ok : has, status: rp?.status ?? null, ms: rp?.ms ?? null, err: rp?.err,
      recall: r3(found.length / u.must_contain.length), content_ok: found.length >= need,
      chars: md.length, tokens: Math.round(md.length / 4),
      missing: u.must_contain.filter((s) => !found.includes(s)),
    });
  }
  const agg = (rs) => ({
    pages: rs.length,
    engine_ok: rs.filter((r) => r.engine_ok).length,
    content_ok: rs.filter((r) => r.content_ok).length,
    content_ok_share: r3(rs.filter((r) => r.content_ok).length / Math.max(1, rs.length)),
    empty_or_wrong_share: r3(rs.filter((r) => r.engine_ok && !r.content_ok).length / Math.max(1, rs.length)),
    error_share: r3(rs.filter((r) => !r.engine_ok).length / Math.max(1, rs.length)),
    p50_ms: median(rs.filter((r) => r.engine_ok).map((r) => r.ms)),
    tokens_median: median(rs.filter((r) => r.has_output).map((r) => r.tokens)),
  });
  const normal = rows.filter((r) => !r.hard);
  const by = {};
  for (const r of normal) (by[r.category] ||= []).push(r);
  return {
    kind: 'score', engine, corpus: 'live', scored_at: new Date().toISOString(),
    // "hard" pages commonly block bots: reported on their own, never counted as engine failures
    overall: agg(normal),
    static_html: agg(normal.filter((r) => !r.js)),
    js: agg(normal.filter((r) => r.js)),
    hard: agg(rows.filter((r) => r.hard)),
    by_category: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, agg(v)])),
    pages: rows,
  };
}

function selfcheck() {
  const manifest = readJson(join(HERE, 'corpus', 'manifest.json'));
  const TEXT = join(HERE, '.work', 'corpus', 'text');
  let bad = 0, nMust = 0, nNot = 0;
  for (const dir of ['_source-main', '_source-all']) mkdirSync(join(OUT, dir), { recursive: true });
  for (const m of manifest) {
    const truth = readJson(join(HERE, 'corpus', 'truth', m.id + '.json'));
    const mainRaw = readFileSync(join(TEXT, m.id + '.main.txt'), 'utf8');
    const restRaw = readFileSync(join(TEXT, m.id + '.rest.txt'), 'utf8');
    const main = norm(mainRaw), rest = norm(restRaw);
    for (const s of truth.must_contain) {
      nMust++;
      const hay = s.outside_container ? rest : main;
      if (!hay.includes(norm(s.text))) { bad++; console.log(`FAIL ${m.id} must_contain not in source ${s.outside_container ? 'page' : 'main'} text: ${s.text}`); }
    }
    for (const s of truth.must_not_contain) {
      nNot++;
      if (main.includes(norm(s.text))) { bad++; console.log(`FAIL ${m.id} must_not_contain occurs in main text: ${s.text}`); }
      if (!rest.includes(norm(s.text))) { bad++; console.log(`FAIL ${m.id} must_not_contain not in page text: ${s.text}`); }
    }
    // calibration pseudo-engines: the source's own main text, and the whole page text
    const heads = truth.must_contain.filter((s) => s.outside_container).map((s) => s.text).join('\n');
    writeFileSync(join(OUT, '_source-main', m.id + '.md'), heads + '\n' + mainRaw);
    writeFileSync(join(OUT, '_source-all', m.id + '.md'), restRaw + '\n' + mainRaw);
  }
  console.log(`selfcheck: ${manifest.length} pages, ${nMust} must_contain, ${nNot} must_not_contain, ${bad} problems`);
  for (const e of ['_source-main', '_source-all']) {
    const o = scoreStatic(e).overall;
    console.log(`  ${e}: recall ${o.recall_mean}, noise ${o.noise_mean}, perfect ${o.perfect_share}`);
  }
  process.exit(bad ? 1 : 0);
}

function printSummary(s) {
  const o = s.overall;
  if (s.corpus === 'static') {
    console.log(`${s.engine} / static: recall ${o.recall_mean} (median ${o.recall_median}), noise ${o.noise_mean}, structure ${o.structure_mean}, perfect ${(o.perfect_share * 100).toFixed(1)}%, failures ${(o.failure_share * 100).toFixed(1)}%, median tokens ${o.tokens_median}, answered ${o.answered}/${o.pages}`);
  } else {
    console.log(`${s.engine} / live: content ok ${o.content_ok}/${o.pages} (${(o.content_ok_share * 100).toFixed(1)}%), js ${s.js.content_ok}/${s.js.pages}, hard ${s.hard.content_ok}/${s.hard.pages}, p50 ${o.p50_ms} ms`);
  }
}

if (flag('selfcheck')) selfcheck();
mkdirSync(RESULTS, { recursive: true });
const engines = flag('all') ? (existsSync(OUT) ? readdirSync(OUT).filter((d) => !d.startsWith('_') && !d.startsWith('.')) : []) : [opt('engine')];
if (!engines.length || !engines[0]) { console.error('usage: node bench/score.mjs --engine <name> [--corpus static|live] | --all | --selfcheck'); process.exit(2); }
for (const engine of engines) {
  const dir = join(OUT, engine);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const want = opt('corpus');
  const corpora = want ? [want] : [files.some((f) => /^\d{4}\.md$/.test(f)) && 'static', (files.some((f) => /^L\d+\.md$/.test(f)) || existsSync(join(RESULTS, `${engine}.live.json`))) && 'live'].filter(Boolean);
  for (const c of corpora) {
    const s = c === 'static' ? scoreStatic(engine) : scoreLive(engine);
    if (!engine.startsWith('_')) writeFileSync(opt('out', join(RESULTS, `${engine}.${c}.score.json`)), JSON.stringify(s, null, 1) + '\n');
    printSummary(s);
    const worst = Number(opt('worst', 0));
    if (worst && c === 'static') {
      const rows = s.pages.slice().sort((a, b) => (a.recall ?? 1) - (b.recall ?? 1) || (b.noise ?? 0) - (a.noise ?? 0) || (a.structure ?? 1) - (b.structure ?? 1)).slice(0, worst);
      for (const r of rows) {
        console.log(`  ${r.id} ${r.category} recall ${r.recall} noise ${r.noise} structure ${r.structure} chars ${r.chars}  ${r.url}`);
        for (const m of r.missing) console.log(`      missing [${m.kind}] ${m.text}`);
        for (const m of r.noise_found) console.log(`      noise   [${m.kind}] ${m.text}`);
      }
    }
  }
}
