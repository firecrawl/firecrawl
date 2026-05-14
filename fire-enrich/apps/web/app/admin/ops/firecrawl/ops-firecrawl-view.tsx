'use client';

import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/app/playground/_components/PageHeader';
import { Panel, PanelBody, PanelHeader } from '@/app/playground/_components/Panel';

interface QueueRow {
  name: string;
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
  delayed?: number;
}

interface QueuesPayload {
  queues: QueueRow[];
  numbers: Record<string, number>;
  generatedAt: string;
  warning?: string;
}

interface ErrorPayload {
  code?: string;
  error?: string;
  detail?: string;
}

const REFRESH_MS = 10_000;
const BULLBOARD_PATH = '/api/admin/ops/firecrawl/bullboard';

export function OpsFirecrawlView() {
  const [data, setData] = useState<QueuesPayload | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await fetch('/api/admin/ops/firecrawl/queues', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json ?? { error: `HTTP ${res.status}` });
        setData(null);
      } else {
        setData(json as QueuesPayload);
        setError(null);
      }
    } catch (err) {
      setError({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex min-h-svh flex-col">
      <PageHeader
        title="Firecrawl"
        subtitle="Queue depth, recent activity, and process metrics from the self-hosted backend."
        endpoint={data ? `${data.queues.length} queues` : 'fetching…'}
        right={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            className="inline-flex h-32 items-center gap-6 rounded-8 border border-border-muted bg-accent-white px-12 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40"
          >
            <RefreshCw className={`h-14 w-14 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      <div className="flex-1 px-24 pb-48 pt-24">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-20">
          {error && (
            <UnconfiguredOrError error={error} />
          )}

          {!error && data && (
            <>
              <QueueTable queues={data.queues} warning={data.warning} />
              <ResourceTiles numbers={data.numbers} />
              <BullBoardEmbed />
            </>
          )}

          {!error && !data && (
            <div className="flex items-center justify-center rounded-12 border border-border-muted bg-background-lighter p-48 text-body-small text-black-alpha-56">
              <Loader2 className="mr-8 h-16 w-16 animate-spin text-heat-100" />
              Pulling metrics from Firecrawl…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueTable({
  queues,
  warning,
}: {
  queues: QueueRow[];
  warning?: string;
}) {
  return (
    <Panel>
      <PanelHeader title="Queues" />
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead className="bg-background-lighter">
            <tr>
              <Th>Queue</Th>
              <Th align="right">Waiting</Th>
              <Th align="right">Active</Th>
              <Th align="right">Completed</Th>
              <Th align="right">Failed</Th>
              <Th align="right">Delayed</Th>
            </tr>
          </thead>
          <tbody>
            {queues.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-16 py-24 text-center text-body-small text-black-alpha-56"
                >
                  {warning ?? 'No queues reported by /admin/{key}/metrics yet.'}
                </td>
              </tr>
            )}
            {queues.map((q, i) => (
              <tr key={q.name}>
                <Td isLast={i === queues.length - 1} className="font-mono text-mono-small text-accent-black">
                  {q.name}
                </Td>
                <Td isLast={i === queues.length - 1} align="right" className="font-mono text-mono-small">{numOrDim(q.waiting)}</Td>
                <Td isLast={i === queues.length - 1} align="right" className="font-mono text-mono-small">{numOrDim(q.active)}</Td>
                <Td isLast={i === queues.length - 1} align="right" className="font-mono text-mono-small">{numOrDim(q.completed)}</Td>
                <Td isLast={i === queues.length - 1} align="right" className="font-mono text-mono-small">{numOrDim(q.failed)}</Td>
                <Td isLast={i === queues.length - 1} align="right" className="font-mono text-mono-small">{numOrDim(q.delayed)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ResourceTiles({ numbers }: { numbers: Record<string, number> }) {
  const tiles = [
    {
      key: 'process_resident_memory_bytes',
      label: 'Memory',
      format: (v: number) => `${(v / (1024 * 1024)).toFixed(0)} MB`,
    },
    {
      key: 'nodejs_active_handles_total',
      label: 'Active handles',
      format: (v: number) => v.toString(),
    },
    {
      key: 'nodejs_active_requests_total',
      label: 'Active requests',
      format: (v: number) => v.toString(),
    },
    {
      key: 'nodejs_eventloop_lag_seconds',
      label: 'Event-loop lag',
      format: (v: number) => `${(v * 1000).toFixed(1)} ms`,
    },
  ];

  const present = tiles.filter((t) => numbers[t.key] !== undefined);
  if (present.length === 0) return null;

  return (
    <Panel>
      <PanelHeader title="Process snapshot" />
      <PanelBody>
        <div className="grid grid-cols-2 gap-16 md:grid-cols-4">
          {present.map((t) => (
            <div
              key={t.key}
              className="rounded-10 border border-border-muted bg-background-lighter px-16 py-12"
            >
              <div className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-48">
                {t.label}
              </div>
              <div className="mt-4 font-mono text-mono-medium text-accent-black">
                {t.format(numbers[t.key])}
              </div>
            </div>
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

function BullBoardEmbed() {
  return (
    <Panel>
      <PanelHeader
        title="Bull-Board"
        right={
          <a
            href={BULLBOARD_PATH}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-28 items-center gap-6 rounded-6 border border-border-muted bg-accent-white px-10 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4"
          >
            <ExternalLink className="h-12 w-12" />
            Open in tab
          </a>
        }
      />
      <iframe
        src={BULLBOARD_PATH}
        title="Bull-Board"
        className="block h-[640px] w-full border-0"
      />
    </Panel>
  );
}

function UnconfiguredOrError({ error }: { error: ErrorPayload }) {
  const isUnconfigured = error.code === 'unconfigured';
  return (
    <div
      role="alert"
      className={`rounded-10 border p-16 text-body-small ${
        isUnconfigured
          ? 'border-border-muted bg-background-lighter text-black-alpha-72'
          : 'border-accent-crimson text-accent-crimson'
      }`}
      style={
        isUnconfigured
          ? undefined
          : { backgroundColor: 'rgba(235, 52, 36, 0.06)' }
      }
    >
      <div className="font-medium">
        {isUnconfigured ? 'Not configured' : 'Upstream error'}
      </div>
      <div className="mt-4 break-words">{error.error ?? 'unknown'}</div>
      {error.detail && (
        <pre className="mt-8 overflow-x-auto rounded-6 bg-black-alpha-4 p-8 font-mono text-mono-x-small">
          {error.detail}
        </pre>
      )}
    </div>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={[
        'border-b border-border-faint px-16 py-12',
        'text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56',
        align === 'right' ? 'text-right' : 'text-left',
      ].join(' ')}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  isLast,
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  isLast: boolean;
  className?: string;
}) {
  return (
    <td
      className={[
        'px-16 py-12 align-middle text-body-small',
        isLast ? '' : 'border-b border-border-faint',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      ].join(' ')}
    >
      {children}
    </td>
  );
}

function numOrDim(n: number | undefined) {
  if (n === undefined) return <span className="text-black-alpha-32">—</span>;
  return n.toLocaleString();
}
