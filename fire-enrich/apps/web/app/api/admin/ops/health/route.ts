// /api/admin/ops/health
// Parallel health probe for every component of the self-hosted stack.
// Server-side only — never returns BULL_AUTH_KEY or any internal URL.

import {
  AdminUnauthorizedError,
  requireAdmin,
} from '@fire-enrich/core/server';
import { getDb, listPrincipals } from '@fire-enrich/db';

import {
  firecrawlBackendUrl,
  mcpBackendUrl,
  probeFetch,
  runProbe,
  unconfiguredProbe,
  type ProbeResult,
} from '@/lib/ops/probe';

function adminGuard(req: Request): Response | null {
  try {
    requireAdmin(req.headers);
    return null;
  } catch (err) {
    if (err instanceof AdminUnauthorizedError) {
      return Response.json(
        { code: err.code, error: err.message },
        { status: 401 },
      );
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const probes = await Promise.all([
    probeWebApp(),
    probeFireEnrichDb(),
    probeFirecrawlApi(),
    probeFirecrawlAdmin(),
    probeFirecrawlPlaywright(),
    probeMcp(),
  ]);

  return Response.json({ probes, generatedAt: new Date().toISOString() });
}

async function probeWebApp(): Promise<ProbeResult> {
  return {
    service: 'fire-enrich-web',
    status: 'up',
    latencyMs: 0,
    message: 'process serving this request',
    checkedAt: new Date().toISOString(),
  };
}

async function probeFireEnrichDb(): Promise<ProbeResult> {
  return runProbe({
    service: 'fire-enrich-db',
    run: async () => {
      const db = getDb();
      // listPrincipals does a SELECT under the hood — cheaper than a full
      // raw `select 1` because it reuses the existing query builder, and
      // it confirms the schema is reachable, not just the TCP port.
      const rows = await listPrincipals(db);
      return { message: `principals count: ${rows.length}` };
    },
  });
}

async function probeFirecrawlApi(): Promise<ProbeResult> {
  const base = firecrawlBackendUrl();
  if (!base) {
    return unconfiguredProbe(
      'firecrawl-api',
      'Set FIRECRAWL_INTERNAL_URL (or FIRECRAWL_API_URL) to enable this probe.',
    );
  }
  return runProbe({
    service: 'firecrawl-api',
    run: async () => {
      const { body } = await probeFetch(`${base}/`);
      // GET / returns a small JSON greeting in upstream firecrawl.
      let detail: Record<string, unknown> | undefined;
      try {
        detail = JSON.parse(body) as Record<string, unknown>;
      } catch {
        /* not JSON; that's fine */
      }
      return {
        message: 'root responded 200',
        detail,
      };
    },
  });
}

async function probeFirecrawlAdmin(): Promise<ProbeResult> {
  const base = firecrawlBackendUrl();
  const key = process.env.BULL_AUTH_KEY?.trim();
  if (!base) {
    return unconfiguredProbe(
      'firecrawl-redis',
      'Set FIRECRAWL_INTERNAL_URL to enable Redis health probe.',
    );
  }
  if (!key) {
    return unconfiguredProbe(
      'firecrawl-redis',
      'Set BULL_AUTH_KEY to enable the gated Redis health probe.',
    );
  }
  return runProbe({
    service: 'firecrawl-redis',
    run: async () => {
      const { body } = await probeFetch(
        `${base}/admin/${encodeURIComponent(key)}/redis-health`,
      );
      return { message: body.slice(0, 120) };
    },
  });
}

async function probeFirecrawlPlaywright(): Promise<ProbeResult> {
  // The playwright-service binds inside the docker network only.
  // We probe it through the api container's feng-check endpoint, which
  // exercises the browser pool end-to-end. That's a heavier check, but
  // the only one available without exposing the playwright port.
  const base = firecrawlBackendUrl();
  const key = process.env.BULL_AUTH_KEY?.trim();
  if (!base) {
    return unconfiguredProbe(
      'firecrawl-playwright',
      'Set FIRECRAWL_INTERNAL_URL to enable browser-pool probe.',
    );
  }
  if (!key) {
    return unconfiguredProbe(
      'firecrawl-playwright',
      'Set BULL_AUTH_KEY to enable browser-pool probe.',
    );
  }
  return runProbe({
    service: 'firecrawl-playwright',
    timeoutMs: 8000,
    run: async () => {
      const { body } = await probeFetch(
        `${base}/admin/${encodeURIComponent(key)}/feng-check`,
      );
      return { message: body.slice(0, 120) };
    },
  });
}

async function probeMcp(): Promise<ProbeResult> {
  const base = mcpBackendUrl();
  if (!base) {
    return unconfiguredProbe(
      'firecrawl-mcp',
      'Set MCP_INTERNAL_URL to point at the MCP HTTP server (compose-network hostname).',
    );
  }
  return runProbe({
    service: 'firecrawl-mcp',
    run: async () => {
      await probeFetch(`${base}/health`);
      return { message: 'ok' };
    },
  });
}
