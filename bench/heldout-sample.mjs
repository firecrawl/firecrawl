// Draws a seeded sample from Firecrawl's public scrape dataset for heldout.mjs.
//   node bench/heldout-sample.mjs --csv <path to 1-0-0.csv> [--n 300] [--seed 42] [--tag name]
// Keeps rows with no recorded error and a usable truth text, at most one per
// domain, and writes bench/.work/heldout/sample<tag>.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
if (!args.csv) { console.error('--csv <path> is required'); process.exit(2); }
const n = Number(args.n || 300), tag = args.tag || '';

function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Small seeded generator (mulberry32) so the same seed draws the same sample.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const rows = parseCsv(readFileSync(args.csv, 'utf8'));
const header = rows.shift();
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
for (const need of ['id', 'url', 'truth_text']) if (!(need in col)) { console.error(`missing column ${need}`); process.exit(2); }
const usable = rows
  .map(r => ({ id: r[col.id], url: r[col.url], truth: (r[col.truth_text] || '').trim(), lie: (r[col.lie_text] || '').trim(), error: (r[col.error] || '').trim() }))
  .filter(r => /^https?:\/\//.test(r.url) && r.truth.length >= 40 && !r.error);
const random = rng(Number(args.seed || 42));
for (let i = usable.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [usable[i], usable[j]] = [usable[j], usable[i]]; }
const seen = new Set(), sample = [];
for (const r of usable) {
  let host; try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { continue; }
  if (seen.has(host)) continue;
  seen.add(host); sample.push({ id: r.id, url: r.url, truth: r.truth, lie: r.lie });
  if (sample.length >= n) break;
}
const here = new URL('.', import.meta.url).pathname;
mkdirSync(here + '.work/heldout', { recursive: true });
writeFileSync(here + `.work/heldout/sample${tag}.json`, JSON.stringify(sample, null, 1));
console.log(`usable rows ${usable.length}, sampled ${sample.length} -> bench/.work/heldout/sample${tag}.json`);
