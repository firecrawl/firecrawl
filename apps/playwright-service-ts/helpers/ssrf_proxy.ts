import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import IPAddr from 'ipaddr.js';

const isPrivateIp = (ip: string): boolean => {
  if (!IPAddr.isValid(ip)) return true;
  return IPAddr.parse(ip).range() !== 'unicast';
};

const resolveSafely = async (hostname: string): Promise<string> => {
  if (IPAddr.isValid(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`blocked private IP ${hostname}`);
    }
    return hostname;
  }
  const all = await lookup(hostname, { all: true, verbatim: true });
  if (all.length === 0) throw new Error(`hostname ${hostname} did not resolve`);
  for (const { address } of all) {
    if (isPrivateIp(address)) {
      throw new Error(`hostname ${hostname} resolves to private IP ${address}`);
    }
  }
  return all[0].address;
};

export async function startSsrfProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) throw new Error('missing url');
      const target = new URL(req.url);
      const port = target.port ? Number.parseInt(target.port, 10) : 80;
      const ip = await resolveSafely(target.hostname);

      const forward = http.request({
        host: ip,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers: { ...req.headers, host: target.host },
      });
      forward.on('response', upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      });
      forward.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`bad gateway: ${err.message}`);
        } else {
          res.destroy();
        }
      });
      req.pipe(forward);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'blocked';
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`blocked: ${message}`);
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    const [host, portStr] = (req.url ?? '').split(':');
    const port = portStr ? Number.parseInt(portStr, 10) : 443;
    try {
      const ip = await resolveSafely(host);
      const upstream = net.connect(port, ip);
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      clientSocket.on('error', () => upstream.destroy());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'blocked';
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(`blocked: ${message}`)}\r\n\r\nblocked: ${message}`,
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('ssrf proxy failed to bind');

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    }),
  };
}
