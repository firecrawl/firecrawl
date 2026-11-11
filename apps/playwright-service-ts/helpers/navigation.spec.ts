import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';

let service: ChildProcess;
let fixture: http.Server;
let origin: string;
let serviceOrigin: string;
let logs = '';

const listen = async (server: http.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

before(async () => {
  fixture = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const html = (body: string, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body>${body}</body></html>`);
    };
    switch (url.pathname) {
      case '/redirect':
        res.writeHead(302, { Location: '/missing' });
        res.end();
        break;
      case '/navigate':
        html(`<script>window.addEventListener('load', () => {
          setTimeout(() => location.href = ${JSON.stringify(url.searchParams.get('to'))}, 50);
        });</script>START`);
        break;
      case '/missing':
        html('DESTINATION_MARKER', 404);
        break;
      case '/json':
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end('{"destination":true}');
        break;
      case '/text':
        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('PLAIN_DESTINATION');
        break;
      case '/frame':
        html('FRAME_FAILURE', 503);
        break;
      case '/with-frame':
        html('MAIN_DOCUMENT<iframe src="/frame"></iframe>');
        break;
      case '/history':
        html("HISTORY_DOCUMENT<script>history.replaceState({}, '', '/renamed');</script>");
        break;
      default:
        html('DIRECT_DOCUMENT');
    }
  });
  origin = `http://127.0.0.1:${await listen(fixture)}`;

  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  serviceOrigin = `http://127.0.0.1:${port}`;
  service = spawn(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../api.ts')], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      // These fixtures are loopback-only; production defaults remain unchanged.
      ALLOW_LOCAL_WEBHOOKS: 'true',
      PROXY_SERVER: '',
      PROXY_USERNAME: '',
      PROXY_PASSWORD: '',
      BLOCK_MEDIA: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout!.on('data', (chunk) => { logs += chunk; });
  service.stderr!.on('data', (chunk) => { logs += chunk; });
  service.on('error', (error) => { logs += error.message; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) break;
    try {
      const response = await fetch(`${serviceOrigin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Playwright service failed to start:\n${logs}`);
});

after(async () => {
  if (service?.pid && service.exitCode === null) {
    const exited = once(service, 'exit');
    process.kill(-service.pid, 'SIGKILL');
    await exited;
  }
  if (fixture?.listening) {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

const scrape = async (pathname: string, wait = 0) => {
  const response = await fetch(`${serviceOrigin}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: origin + pathname, wait_after_load: wait, timeout: 10000 }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

test('reports the original document when no navigation occurs', async () => {
  const result = await scrape('/direct');
  assert.equal(result.url, origin + '/direct');
  assert.equal(result.pageStatusCode, 200);
  assert.match(result.content, /DIRECT_DOCUMENT/);
});

test('reports the destination of an HTTP redirect', async () => {
  const result = await scrape('/redirect');
  assert.equal(result.url, origin + '/missing');
  assert.equal(result.pageStatusCode, 404);
  assert.match(result.content, /DESTINATION_MARKER/);
});

test('reports the final document status after JavaScript navigation during the wait', async () => {
  const result = await scrape('/navigate?to=/missing', 500);
  assert.equal(result.url, origin + '/missing');
  assert.match(result.content, /DESTINATION_MARKER/);
  assert.equal(result.pageStatusCode, 404);
});

test('uses the final JSON response body, content type and status', async () => {
  const result = await scrape('/navigate?to=/json', 500);
  assert.equal(result.url, origin + '/json');
  assert.equal(result.content, '{"destination":true}');
  assert.equal(result.contentType, 'application/json');
  assert.equal(result.pageStatusCode, 415);
});

test('uses the final plain-text response body, content type and status', async () => {
  const result = await scrape('/navigate?to=/text', 500);
  assert.equal(result.url, origin + '/text');
  assert.equal(result.content, 'PLAIN_DESTINATION');
  assert.equal(result.contentType, 'text/plain; charset=utf-8');
  assert.equal(result.pageStatusCode, 410);
});

test('does not replace the main document response with an iframe response', async () => {
  const result = await scrape('/with-frame');
  assert.equal(result.url, origin + '/with-frame');
  assert.equal(result.pageStatusCode, 200);
  assert.match(result.content, /MAIN_DOCUMENT/);
});

test('preserves same-document history changes without inventing a new response', async () => {
  const result = await scrape('/history');
  assert.equal(result.url, origin + '/renamed');
  assert.equal(result.pageStatusCode, 200);
  assert.match(result.content, /HISTORY_DOCUMENT/);
});
