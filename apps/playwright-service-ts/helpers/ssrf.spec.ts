import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { AddressInfo } from 'node:net';
import { LookupAddress } from 'node:dns';
import { Server } from 'proxy-chain';
import {
  pinnedLookup,
  resolvePublicAddresses,
  ssrfPrepareRequest,
} from './ssrf';

const PUBLIC_IP = '8.8.8.8';

const listen = async (server: net.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const startTarget = async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end('internal');
  });
  const port = await listen(server);
  return { port, hits: () => hits, close: () => server.close() };
};

const startProxy = async (resolve: (h: string) => Promise<LookupAddress[]>) => {
  const server = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: ssrfPrepareRequest({ allowLocal: false, resolve }),
  });
  await server.listen();
  return { port: server.port, close: () => server.close(true) };
};

const requestViaProxy = (
  proxyPort: number,
  url: string,
): Promise<number | 'error'> =>
  new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: url,
      headers: { host: new URL(url).host },
      timeout: 1000,
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve('error'));
    req.end();
  });

const connectViaProxy = (proxyPort: number, target: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
      timeout: 1000,
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('Proxy CONNECT timed out')));
    req.on('error', reject);
    req.end();
  });

test('resolvePublicAddresses rejects non-unicast addresses', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ]) {
    assert.equal(await resolvePublicAddresses(ip), null, ip);
  }
  assert.deepEqual(await resolvePublicAddresses('8.8.8.8'), [
    { address: '8.8.8.8', family: 4 },
  ]);
});

test('resolvePublicAddresses rejects a host if any address is internal', async () => {
  const mixed = async () => [
    { address: PUBLIC_IP, family: 4 },
    { address: '10.0.0.1', family: 4 },
  ];
  assert.equal(await resolvePublicAddresses('mixed.test', mixed), null);
  assert.equal(
    await resolvePublicAddresses('empty.test', async () => []),
    null,
  );
  assert.equal(
    await resolvePublicAddresses('fail.test', async () => {
      throw new Error('ENOTFOUND');
    }),
    null,
  );
});

test('pinnedLookup makes the socket connect to the pinned address without DNS', async () => {
  const server = net.createServer((s) => s.end());
  const port = await listen(server);
  try {
    const remote = await new Promise<string | undefined>((resolve, reject) => {
      const socket = net.connect({
        host: 'never-resolved.invalid',
        port,
        lookup: pinnedLookup([{ address: '127.0.0.1', family: 4 }]),
      });
      socket.on('connect', () => {
        resolve(socket.remoteAddress);
        socket.destroy();
      });
      socket.on('error', reject);
    });
    assert.equal(remote, '127.0.0.1');
  } finally {
    server.close();
  }
});

test('proxy returns 403 for a host that resolves to a private address', async () => {
  const target = await startTarget();
  const proxy = await startProxy(async () => [
    { address: '127.0.0.1', family: 4 },
  ]);
  try {
    assert.equal(
      await requestViaProxy(proxy.port, `http://private.test:${target.port}/`),
      403,
    );
    assert.equal(
      await connectViaProxy(proxy.port, `private.test:${target.port}`),
      403,
    );
    assert.equal(target.hits(), 0);
  } finally {
    await proxy.close();
    target.close();
  }
});

test('proxy does not resolve the host again at connect time (DNS rebinding)', async () => {
  // The check sees a public address. A second lookup of "localhost" through
  // the system resolver would return loopback, as a rebinding record would.
  const target = await startTarget();
  let calls = 0;
  const proxy = await startProxy(async () => {
    calls++;
    return [{ address: PUBLIC_IP, family: 4 }];
  });
  try {
    const status = await requestViaProxy(
      proxy.port,
      `http://localhost:${target.port}/`,
    );
    assert.notEqual(status, 200);
    assert.equal(calls, 1);
    assert.equal(target.hits(), 0);
  } finally {
    await proxy.close();
    target.close();
  }
});

test('with an upstream proxy, no dnsLookup is pinned', async () => {
  const prepare = ssrfPrepareRequest({
    allowLocal: false,
    upstreamProxyUrl: 'http://proxy.internal:8080',
    resolve: async () => [{ address: PUBLIC_IP, family: 4 }],
  });
  const result = await prepare({ hostname: 'example.test' } as never);
  assert.deepEqual(result, { upstreamProxyUrl: 'http://proxy.internal:8080' });
});
