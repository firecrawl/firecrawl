#!/usr/bin/env node
// Static corpus server. No dependencies.
//
//   node bench/serve.mjs [--port 3900] [--host 127.0.0.1] [--workers 4] [--delay-ms 0] [--no-csp]
//
// Serves bench/.work/corpus/pages/NNNN.html at /p/NNNN.html from memory with
// `content-type: text/html; charset=utf-8`, keep-alive on, and an allow-all /robots.txt.
// By default every page carries a Content-Security-Policy that stops browsers from running
// scripts or loading subresources, so a snapshot renders the same on every run and no engine
// spends time (or gains content) fetching third-party assets. Truth is derived from the same bytes.
import cluster from 'node:cluster';
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '.work', 'corpus', 'pages');
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const port = Number(arg('port', 3900));
const host = arg('host', '127.0.0.1');
const workers = Number(arg('workers', 4));
const delayMs = Number(arg('delay-ms', 0));
const csp = !process.argv.includes('--no-csp');

if (!existsSync(PAGES)) {
  console.error(`no corpus at ${PAGES}; run: node bench/corpus/fetch.mjs`);
  process.exit(1);
}

if (cluster.isPrimary && workers > 1) {
  let ready = 0;
  for (let i = 0; i < workers; i++) cluster.fork().on('message', (m) => {
    if (m === 'ready' && ++ready === workers) console.log(`corpus server on http://${host}:${port}/p/NNNN.html (${workers} workers, csp=${csp}, delay=${delayMs}ms)`);
  });
  cluster.on('exit', (w, code) => { if (code !== 0) { console.error('worker died', code); process.exit(1); } });
  const stop = () => { for (const w of Object.values(cluster.workers)) w.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  const pages = new Map();
  for (const f of readdirSync(PAGES)) if (/^\d{4}\.html$/.test(f)) pages.set('/p/' + f, readFileSync(join(PAGES, f)));
  const baseHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...(csp ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'" } : {}),
  };
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const body = pages.get(path);
    const send = () => {
      if (body) {
        res.writeHead(200, { ...baseHeaders, 'content-length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
      } else if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nAllow: /\n');
      } else if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pages: pages.size }));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
      }
    };
    if (delayMs > 0 && body) setTimeout(send, delayMs); else send();
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.listen(port, host, 2048, () => {
    if (process.send) process.send('ready');
    else console.log(`corpus server on http://${host}:${port}/p/NNNN.html (1 worker, csp=${csp}, ${pages.size} pages)`);
  });
}
