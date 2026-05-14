// Tiny Cloudflare Access JWT verifier for Traefik forwardAuth.
//
// One container covers many Access applications via a comma-separated
// CF_ACCESS_AUDS map. Each Traefik middleware passes its app key in the
// `?aud=` query string; the verifier picks the corresponding audience tag.
//
// Wiring (Traefik label):
//   forwardauth.address=http://cf-access-verifier:8080/verify?aud=dashboard
//   forwardauth.authResponseHeaders=X-Auth-User-Email,X-Auth-User-Sub

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const TEAM = required('CF_ACCESS_TEAM');
const PORT = Number(process.env.PORT ?? 8080);
const AUDS = parseAudMap(process.env.CF_ACCESS_AUDS ?? '');

if (Object.keys(AUDS).length === 0) {
  console.error(
    '[cf-access-verifier] CF_ACCESS_AUDS is empty. Set e.g. ' +
      'CF_ACCESS_AUDS=dashboard:abc123,mcp:def456 to register apps.',
  );
  process.exit(1);
}

const JWKS = createRemoteJWKSet(
  new URL(`https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`),
  { cooldownDuration: 10_000, cacheMaxAge: 60 * 60 * 1000 },
);

const server = createServer((req, res) => {
  // Top-level try/catch so a thrown handler never tears down the process.
  void handle(req, res).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.writeHead(500).end(`internal: ${msg}`);
    } else {
      res.end();
    }
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  if (url.pathname !== '/verify') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  const audKey = url.searchParams.get('aud') ?? '';
  const aud = AUDS[audKey];
  if (!aud) {
    res
      .writeHead(400, { 'content-type': 'text/plain' })
      .end(`unknown aud key: ${audKey}`);
    return;
  }

  // Cloudflare Access ships the JWT both as a header and a cookie. Take
  // either, prefer the header — it is set on every proxied request.
  const headerVal = req.headers['cf-access-jwt-assertion'];
  const headerJwt =
    typeof headerVal === 'string'
      ? headerVal
      : Array.isArray(headerVal)
        ? headerVal[0]
        : undefined;
  const cookieJwt = parseCookie(req.headers.cookie ?? '', 'CF_Authorization');
  const jwt = headerJwt ?? cookieJwt;

  if (!jwt) {
    res
      .writeHead(401, { 'content-type': 'text/plain' })
      .end('missing CF-Access-Jwt-Assertion header / CF_Authorization cookie');
    return;
  }

  try {
    const { payload } = await jwtVerify(jwt, JWKS, {
      audience: aud,
      issuer: `https://${TEAM}.cloudflareaccess.com`,
    });
    res
      .writeHead(200, {
        'X-Auth-User-Email': String(payload.email ?? ''),
        'X-Auth-User-Sub': String(payload.sub ?? ''),
        'X-Auth-User-Issuer': String(payload.iss ?? ''),
        'content-type': 'text/plain',
      })
      .end('ok');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res
      .writeHead(401, { 'content-type': 'text/plain' })
      .end(`invalid jwt: ${msg}`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.error(
    `[cf-access-verifier] listening on :${PORT} | team=${TEAM} | auds=${Object.keys(
      AUDS,
    ).join(',')}`,
  );
});

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[cf-access-verifier] ${name} env var is required`);
    process.exit(1);
  }
  return v;
}

/**
 * CF_ACCESS_AUDS=dashboard:abc123,mcp:def456
 * Returns { dashboard: 'abc123', mcp: 'def456' }.
 */
function parseAudMap(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
