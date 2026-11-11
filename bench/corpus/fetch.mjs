#!/usr/bin/env node
// Snapshot the static corpus once. Plain GETs, one request per host at a time,
// robots.txt honoured, 15 s timeout. Raw fetches are cached in
// bench/.work/corpus/cache so the manifest can be rebuilt without refetching.
//
//   node bench/corpus/fetch.mjs            # fetch what is not cached, write pages + manifest
//   node bench/corpus/fetch.mjs --refresh  # refetch everything
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, '..', '.work', 'corpus');
const CACHE = join(WORK, 'cache');
const PAGES = join(WORK, 'pages');
const UA = 'firecrawl-bench/0.1 (+https://github.com/firecrawl/firecrawl)';
const UA_TOKEN = 'firecrawl-bench';
const TIMEOUT_MS = 15000;
const HOST_DELAY_MS = 400;
const refresh = process.argv.includes('--refresh');

mkdirSync(CACHE, { recursive: true });
mkdirSync(PAGES, { recursive: true });

const sources = JSON.parse(readFileSync(join(HERE, 'static-sources.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

// ---- robots.txt -----------------------------------------------------------
const robotsCache = new Map();
function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasUa = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasUa) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasUa = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({ allow: key === 'allow', path: val });
      lastWasUa = false;
    } else {
      lastWasUa = false;
    }
  }
  return groups;
}
function ruleRegex(path) {
  const esc = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + (esc.endsWith('\\$') ? esc.slice(0, -2) + '$' : esc));
}
function robotsAllows(groups, pathAndQuery) {
  let group = groups.filter((g) => g.agents.some((a) => a !== '*' && UA_TOKEN.includes(a)));
  if (!group.length) group = groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const g of group) {
    for (const r of g.rules) {
      if (r.path === '') continue; // "Disallow:" means allow all
      if (!ruleRegex(r.path).test(pathAndQuery)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}
async function allowedByRobots(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let groups = [];
    let note = 'ok';
    try {
      const { res, buf } = await get(u.origin + '/robots.txt');
      if (res.status === 200) groups = parseRobots(buf.toString('utf8'));
      else if (res.status >= 500 || res.status === 429 || res.status === 403 || res.status === 401) note = 'robots-unavailable-' + res.status;
    } catch (e) {
      note = 'robots-error';
    }
    robotsCache.set(u.origin, { groups, note });
  }
  const r = robotsCache.get(u.origin);
  // An unreachable or refused robots.txt is treated as "do not fetch".
  if (r.note !== 'ok') return { ok: false, why: r.note };
  return { ok: robotsAllows(r.groups, u.pathname + u.search), why: 'robots-disallow' };
}

// ---- decoding -------------------------------------------------------------
function decodeHtml(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  let text;
  try { text = new TextDecoder(charset).decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); charset = 'utf-8'; }
  let transcoded = false;
  if (charset !== 'utf-8' && charset !== 'utf8') {
    // The corpus server always says charset=utf-8, so keep the in-page declaration consistent.
    text = text.replace(/(<meta[^>]+charset=["']?)[\w-]+/i, '$1utf-8');
    transcoded = true;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, charset, transcoded };
}

const CHALLENGE = [/<title>\s*Just a moment/i, /cf-browser-verification|challenge-platform\/h\//i, /<title>\s*Access Denied/i, /<title>\s*Attention Required/i, /Enable JavaScript and cookies to continue/i, /captcha-delivery\.com/i, /<title>\s*Are you a robot/i];

async function fetchOne(url, category) {
  const key = sha1(url);
  const metaPath = join(CACHE, key + '.json');
  const htmlPath = join(CACHE, key + '.html');
  if (!refresh && existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, 'utf8'));
  const meta = { url, category, ok: false };
  try {
    const rob = await allowedByRobots(url);
    if (!rob.ok) { meta.skip = rob.why; } else {
      const { res, buf } = await get(url);
      meta.status = res.status;
      meta.final_url = res.url;
      const ct = res.headers.get('content-type') || '';
      if (res.status !== 200) meta.skip = 'http-' + res.status;
      else if (!/html/i.test(ct)) meta.skip = 'not-html:' + ct;
      else {
        if (new URL(res.url).origin !== new URL(url).origin) {
          const rob2 = await allowedByRobots(res.url);
          if (!rob2.ok) meta.skip = 'redirect-' + rob2.why;
        }
        if (!meta.skip) {
          const { text, charset, transcoded } = decodeHtml(buf, ct);
          if (CHALLENGE.some((re) => re.test(text.slice(0, 20000)))) meta.skip = 'bot-challenge';
          else {
            writeFileSync(htmlPath, text);
            meta.ok = true;
            meta.source_charset = charset;
            meta.transcoded = transcoded;
            meta.fetched_at = new Date().toISOString();
          }
        }
      }
    }
  } catch (e) {
    meta.skip = 'error:' + (e.cause?.code || e.name || String(e)).slice(0, 80);
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 1));
  return meta;
}

// ---- schedule: hosts in parallel, one request per host at a time ---------------
const jobs = [];
for (const [category, urls] of Object.entries(sources)) for (const url of urls) jobs.push({ url, category });
const byHost = new Map();
for (const j of jobs) {
  const h = new URL(j.url).host;
  if (!byHost.has(h)) byHost.set(h, []);
  byHost.get(h).push(j);
}
const results = new Map();
await Promise.all([...byHost.values()].map(async (list) => {
  for (const j of list) {
    const cached = !refresh && existsSync(join(CACHE, sha1(j.url) + '.json'));
    results.set(j.url, await fetchOne(j.url, j.category));
    if (!cached) await sleep(HOST_DELAY_MS);
  }
}));

// ---- write pages + manifest in source-list order ------------------------------
for (const f of readdirSync(PAGES)) if (/^\d{4}\.html$/.test(f)) rmSync(join(PAGES, f));
const manifest = [];
const skipped = [];
let n = 0;
for (const j of jobs) {
  const m = results.get(j.url);
  if (!m.ok) { skipped.push({ url: j.url, category: j.category, reason: m.skip }); continue; }
  const html = readFileSync(join(CACHE, sha1(j.url) + '.html'));
  const id = String(++n).padStart(4, '0');
  writeFileSync(join(PAGES, id + '.html'), html);
  manifest.push({ id, url: j.url, final_url: m.final_url, category: j.category, bytes: html.length, fetched_at: m.fetched_at, sha256: sha256(html), transcoded_from: m.transcoded ? m.source_charset : undefined });
}
// ---- the repo's own Astro test site, if it has been built into .work/test-site/dist ----
const SITE = join(HERE, '..', '.work', 'test-site', 'dist');
if (existsSync(SITE)) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.html') ? [join(d, e.name)] : []);
  for (const f of walk(SITE).sort()) {
    const rel = f.slice(SITE.length).replace(/index\.html$/, '');
    if (/client-redirect|robots-test/.test(rel)) continue; // behaviour fixtures, not content pages
    const html = readFileSync(f);
    const id = String(++n).padStart(4, '0');
    writeFileSync(join(PAGES, id + '.html'), html);
    manifest.push({ id, url: 'test-site:' + rel, category: 'test-site', bytes: html.length, fetched_at: statSync(f).mtime.toISOString(), sha256: sha256(html) });
  }
}
writeFileSync(join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
writeFileSync(join(WORK, 'skipped.json'), JSON.stringify(skipped, null, 1) + '\n');
const byCat = {};
for (const m of manifest) byCat[m.category] = (byCat[m.category] || 0) + 1;
console.log(`pages: ${manifest.length}  skipped: ${skipped.length}`);
console.log(byCat);
for (const s of skipped) console.log('  skip', s.reason, s.url);
