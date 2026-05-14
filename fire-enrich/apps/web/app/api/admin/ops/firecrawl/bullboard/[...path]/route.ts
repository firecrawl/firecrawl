// /api/admin/ops/firecrawl/bullboard/[...path]
// Streaming proxy for the upstream Firecrawl Bull-Board UI. Injects
// BULL_AUTH_KEY server-side so the browser only ever sees this endpoint —
// the secret stays in the dashboard process. Catch-all so the iframe can
// load every JS/CSS asset Bull-Board pulls in.

import { adminGuard } from '@/lib/ops/admin-guard';
import { firecrawlBackendUrl } from '@/lib/ops/probe';

export const dynamic = 'force-dynamic';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'host',
  'content-length',
  'content-encoding',
]);

async function proxy(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const base = firecrawlBackendUrl();
  const key = process.env.BULL_AUTH_KEY?.trim();
  if (!base || !key) {
    return new Response(
      'Bull-Board is unavailable: set FIRECRAWL_INTERNAL_URL and BULL_AUTH_KEY.',
      { status: 503 },
    );
  }

  const { path } = await params;
  const tail = (path ?? []).map(encodeURIComponent).join('/');
  const url = new URL(req.url);
  const target = `${base}/admin/${encodeURIComponent(key)}/queues${
    tail ? `/${tail}` : ''
  }${url.search}`;

  const upstream = await fetch(target, {
    method: req.method,
    headers: pickRequestHeaders(req.headers),
    body:
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await req.arrayBuffer(),
    redirect: 'manual',
  });

  // Strip set-cookie + auth headers so we don't leak upstream session state
  // back to the user's browser; we own our own auth at the dashboard layer.
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    if (key.toLowerCase() === 'set-cookie') return;
    headers.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function pickRequestHeaders(src: Headers): Headers {
  const headers = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === 'cookie') return; // do not forward the dashboard's cookie upstream
    headers.set(key, value);
  });
  return headers;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
