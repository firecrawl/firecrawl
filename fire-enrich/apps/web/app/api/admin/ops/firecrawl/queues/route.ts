// /api/admin/ops/firecrawl/queues
// Server-side proxy for the Firecrawl backend's queue snapshot. Reaches
// {key}/metrics + nuq-metrics endpoints and returns a normalised JSON
// payload the dashboard can render without parsing Prometheus on the client.

import { adminGuard } from '@/lib/ops/admin-guard';
import { firecrawlBackendUrl } from '@/lib/ops/probe';

interface QueueSnapshot {
  /** Bull / NUQ queues from /admin/{key}/metrics. */
  queues: Array<{
    name: string;
    waiting?: number;
    active?: number;
    completed?: number;
    failed?: number;
    delayed?: number;
  }>;
  /** Loose key-value subset from Prometheus we surface as numeric tiles. */
  numbers: Record<string, number>;
  generatedAt: string;
  warning?: string;
}

export async function GET(req: Request): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const base = firecrawlBackendUrl();
  const key = process.env.BULL_AUTH_KEY?.trim();

  if (!base) {
    return Response.json(
      {
        code: 'unconfigured',
        error:
          'Set FIRECRAWL_INTERNAL_URL or FIRECRAWL_API_URL to surface queue stats.',
      },
      { status: 503 },
    );
  }
  if (!key) {
    return Response.json(
      {
        code: 'unconfigured',
        error:
          'Set BULL_AUTH_KEY to surface queue stats from /admin/{key}/metrics.',
      },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(`${base}/admin/${encodeURIComponent(key)}/metrics`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text();
      return Response.json(
        {
          code: 'upstream_error',
          error: `firecrawl returned HTTP ${res.status}`,
          detail: body.slice(0, 500),
        },
        { status: 502 },
      );
    }
    const text = await res.text();
    const snapshot = parsePrometheus(text);
    return Response.json(snapshot);
  } catch (err) {
    return Response.json(
      {
        code: 'upstream_unreachable',
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

/**
 * Pulls the small subset of Prometheus metrics we care about for the dashboard.
 * Bull / NUQ queue gauges follow the convention `bullmq_<queue>_<state>` and
 * `nuq_<queue>_<state>` — we group them by queue name and return everything
 * else under `numbers` for the resource tiles.
 */
export function parsePrometheus(text: string): QueueSnapshot {
  const lines = text.split('\n');
  const queues: Record<string, QueueSnapshot['queues'][number]> = {};
  const numbers: Record<string, number> = {};

  // Match "metric{labels} 12.34" or "metric 12.34"
  const re = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(re);
    if (!m) continue;
    const [, name, labels, valueRaw] = m;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) continue;

    const queue = pickQueueLabel(labels) ?? extractQueueFromName(name);
    const state = pickQueueState(name);

    if (queue && state) {
      const slot = (queues[queue] ??= { name: queue });
      slot[state] = value;
      continue;
    }

    // Curated subset of "interesting" process-level numbers.
    if (
      name === 'process_resident_memory_bytes' ||
      name === 'process_cpu_user_seconds_total' ||
      name === 'process_cpu_system_seconds_total' ||
      name === 'nodejs_active_handles_total' ||
      name === 'nodejs_active_requests_total' ||
      name === 'nodejs_eventloop_lag_seconds'
    ) {
      numbers[name] = value;
    }
  }

  return {
    queues: Object.values(queues).sort((a, b) => a.name.localeCompare(b.name)),
    numbers,
    generatedAt: new Date().toISOString(),
    warning:
      Object.keys(queues).length === 0
        ? 'No bull/nuq queue metrics found — the API may be using a different naming scheme. The full Prometheus dump is still reachable via /admin/{key}/metrics on the Firecrawl backend.'
        : undefined,
  };
}

function pickQueueLabel(labels?: string): string | null {
  if (!labels) return null;
  const m = labels.match(/queue(?:_name)?="([^"]+)"/);
  return m ? m[1] : null;
}

function pickQueueState(metric: string):
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | null {
  if (/waiting/i.test(metric)) return 'waiting';
  if (/active/i.test(metric)) return 'active';
  if (/completed/i.test(metric)) return 'completed';
  if (/failed/i.test(metric)) return 'failed';
  if (/delayed/i.test(metric)) return 'delayed';
  return null;
}

function extractQueueFromName(metric: string): string | null {
  // bullmq_someQueue_waiting -> someQueue
  const m = metric.match(/^(?:bull(?:mq)?|nuq)_([a-zA-Z0-9]+)_(?:waiting|active|completed|failed|delayed)$/);
  return m ? m[1] : null;
}
