// apps/web/lib/ops/probe.ts
// Parallel health probes for the ops dashboard.
// All probes run server-side; never expose BULL_AUTH_KEY / MCP_INTERNAL_URL
// to the browser.

export type ProbeStatus = 'up' | 'down' | 'unconfigured';

export interface ProbeResult {
  service: string;
  status: ProbeStatus;
  latencyMs: number | null;
  message: string | null;
  detail?: Record<string, unknown> | null;
  checkedAt: string;
}

interface ProbeOptions {
  service: string;
  timeoutMs?: number;
  run: () => Promise<{ message?: string; detail?: Record<string, unknown> }>;
}

export async function runProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 3000;

  try {
    const out = await Promise.race([
      opts.run(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs),
      ),
    ]);
    return {
      service: opts.service,
      status: 'up',
      latencyMs: Math.round(performance.now() - startedAt),
      message: out.message ?? null,
      detail: out.detail ?? null,
      checkedAt,
    };
  } catch (err) {
    return {
      service: opts.service,
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      message: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  }
}

export function unconfiguredProbe(service: string, message: string): ProbeResult {
  return {
    service,
    status: 'unconfigured',
    latencyMs: null,
    message,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Pick the most useful Firecrawl backend URL for the dashboard's server-side
 * proxies. Prefer INTERNAL (compose-network) over the public URL when both
 * are set — internal hops avoid TLS + public routing.
 */
export function firecrawlBackendUrl(): string | null {
  const internal = process.env.FIRECRAWL_INTERNAL_URL?.trim();
  if (internal) return stripTrailingSlash(internal);
  const pub = process.env.FIRECRAWL_API_URL?.trim();
  if (pub) return stripTrailingSlash(pub);
  return null;
}

export function mcpBackendUrl(): string | null {
  const url = process.env.MCP_INTERNAL_URL?.trim();
  return url ? stripTrailingSlash(url) : null;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Tiny wrapped fetch that throws with a useful message on non-2xx, so
 * runProbe's try/catch records something more informative than "fetch failed".
 */
export async function probeFetch(
  url: string,
  init?: RequestInit & { acceptText?: boolean },
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
  });
  const body = await res.text();
  if (!res.ok) {
    const snippet = body.slice(0, 200);
    throw new Error(`HTTP ${res.status} from ${url}${snippet ? ` — ${snippet}` : ''}`);
  }
  return { status: res.status, body };
}
